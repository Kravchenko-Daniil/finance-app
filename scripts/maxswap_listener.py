#!/usr/bin/env python3
"""
MaxSwap-листенер: читает диалог с @MaxSwap_bot через MTProto (юзер-сессия), парсит
сообщения (maxswap_parser) и пишет в finance-API — snapshot баланса карты + log_only
события покупок/возвратов. Дедуп/идемпотентность по client_id = tg_<msgId>.

Это «Сигнал 1 (снимок) + Сигнал 2 (поток)» из aggregator-design.md §2 для счёта maxswap.
Always-on слушатель (для VPS) + одноразовый backfill истории.

Режимы:
  --backfill            прогнать историю с последнего курсора (или всю) → события в API
  --dry-run             ничего не писать, только печатать планируемые вызовы
  (без флагов)          live: catch-up с курсора + run_until_disconnected (для VPS)

Примеры:
  scripts/.venv/bin/python scripts/maxswap_listener.py --backfill --dry-run   # превью
  scripts/.venv/bin/python scripts/maxswap_listener.py --backfill             # залить историю
  scripts/.venv/bin/python scripts/maxswap_listener.py                        # live (VPS)

Креды/токен из .env: TELEGRAM_API_ID/HASH/SESSION, APP_TOKEN. Курсор — scripts/.state/.
"""
import os
import sys
import json
import asyncio
import urllib.request
import urllib.error
from datetime import datetime, timezone

from maxswap_parser import parse_message, message_to_actions

# Логи always-on сервиса — построчно, чтобы systemd-journal видел их сразу (без -u).
sys.stdout.reconfigure(line_buffering=True)

# Пол истории для backfill: старт трекера 10.04.2026 (решение Даниила). Сообщения
# раньше этой даты в backfill не заливаем. Live-режим floor игнорирует (ловит всё новое).
START_DATE = datetime(2026, 4, 10, tzinfo=timezone.utc)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, ".env")
STATE_DIR = os.path.join(ROOT, "scripts", ".state")
STATE_FILE = os.path.join(STATE_DIR, "maxswap.json")

BOT = "MaxSwap_bot"
API_BASE = "https://finance.daniilkravchenko.com/api"
# Браузерный UA обязателен — без него Cloudflare WAF отдаёт 403 / error 1010.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

DRY = "--dry-run" in sys.argv
BACKFILL = "--backfill" in sys.argv


def _arg(name, default=None):
    # --name VALUE
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


MAX = int(_arg("--max", 0) or 0)  # 0 = без лимита; >0 — стоп после N сообщений с действиями (smoke)


def env(key, required=True):
    try:
        with open(ENV) as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        sys.exit(f".env не найден: {ENV}")
    if required:
        sys.exit(f"{key} не найден в .env")
    return None


# --- Курсор (последний обработанный msg_id) ---
def load_cursor():
    try:
        with open(STATE_FILE) as f:
            return int(json.load(f).get("last_msg_id", 0))
    except (FileNotFoundError, ValueError, json.JSONDecodeError):
        return 0


def save_cursor(msg_id):
    if DRY:
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump({"last_msg_id": int(msg_id)}, f)


# --- API ---
def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API_BASE + path, data=data, method=method, headers={
        "Authorization": f"Bearer {env('APP_TOKEN')}",
        "User-Agent": UA, "Accept": "application/json",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {path}: {e.read().decode()[:200]}") from None


def run_action(act):
    """Исполнить один API-вызов (snapshot/event). Возвращает короткую строку-итог."""
    if act["call"] == "snapshot":
        if DRY:
            return f"snapshot {act['account']}={act['amount']}"
        api("POST", "/snapshot", {"balances": [{"account": act["account"], "amount": act["amount"]}]})
        return f"snapshot {act['account']}={act['amount']}"
    if act["call"] == "event":
        b = act["body"]
        label = f"event {b['type']} {b.get('from') or b.get('to')} {b['amount']} «{b['note']}»"
        if DRY:
            return label
        res = api("POST", "/event", b)
        return label + (" [deduped]" if res.get("deduped") else "")
    return f"unknown action {act}"


def process(text, msg_id, at_iso, only_events=False):
    """Разобрать сообщение и исполнить действия. only_events=True → пропустить snapshot
    (backfill истории: баланс уже заанкерен, нужны лишь log_only-события).
    Возвращает список строк-итогов (для лога)."""
    parsed = parse_message(text)
    if not parsed:
        return []
    actions = message_to_actions(parsed, msg_id, at_iso)
    if only_events:
        actions = [a for a in actions if a["call"] != "snapshot"]
    out = []
    for a in actions:
        try:
            out.append(run_action(a))
        except RuntimeError as e:
            out.append(f"ERROR: {e}")
    return out


async def do_backfill(client, entity):
    since = load_cursor()
    print(f"[backfill{' DRY' if DRY else ''}] с msg_id>{since} из @{BOT}\n")
    msgs = []
    async for m in client.iter_messages(entity, min_id=since):
        msgs.append(m)
    msgs.reverse()  # хронологический порядок (snapshot=SET → финал = последнее значение)
    n_msg = n_act = n_skip = 0
    last_id = since
    for m in msgs:
        if m.date and m.date < START_DATE:
            n_skip += 1
            continue  # раньше старта трекера — в историю не заливаем
        at_iso = m.date.isoformat() if m.date else None
        # backfill: только события (история), баланс держим на анкере → only_events=True
        results = process(m.message or "", m.id, at_iso, only_events=True)
        if results:
            n_msg += 1
            n_act += len(results)
            print(f"  id={m.id} {m.date.strftime('%Y-%m-%d %H:%M')}")
            for r in results:
                print(f"      → {r}")
            if MAX and n_msg >= MAX:
                print(f"\n[backfill] стоп по --max {MAX}")
                break
        last_id = max(last_id, m.id)
    # курсор НЕ двигаем при --max (это smoke, не полный проход) и при dry-run
    if not MAX:
        save_cursor(last_id)
    print(f"  (пропущено до старта трекера {START_DATE.date()}: {n_skip})")
    print(f"\n[backfill{' DRY' if DRY else ''}] сообщений с действиями: {n_msg}, "
          f"действий: {n_act}, курсор→{last_id}")


async def run_live(client, entity):
    # catch-up: всё, что пришло пока листенер лежал
    since = load_cursor()
    print(f"[live] catch-up с msg_id>{since}…")
    catchup = []
    async for m in client.iter_messages(entity, min_id=since):
        catchup.append(m)
    catchup.reverse()
    for m in catchup:
        at_iso = m.date.isoformat() if m.date else None
        for r in process(m.message or "", m.id, at_iso):  # live: snapshot + события
            print(f"  catchup id={m.id} → {r}")
        save_cursor(m.id)

    from telethon import events

    @client.on(events.NewMessage(from_users=entity))
    async def handler(event):
        m = event.message
        at_iso = m.date.isoformat() if m.date else None
        for r in process(m.message or "", m.id, at_iso):
            print(f"  live id={m.id} → {r}")
        save_cursor(m.id)

    print(f"[live] слушаю @{BOT}. Ctrl-C для остановки.")
    await client.run_until_disconnected()


async def main():
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    api_id = int(env("TELEGRAM_API_ID"))
    api_hash = env("TELEGRAM_API_HASH")
    session = env("TELEGRAM_SESSION")

    client = TelegramClient(StringSession(session), api_id, api_hash)
    await client.start()
    entity = await client.get_entity(BOT)

    if BACKFILL:
        await do_backfill(client, entity)
    else:
        await run_live(client, entity)
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
