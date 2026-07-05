#!/usr/bin/env python3
"""
MaxSwap-листенер: читает диалог с @MaxSwap_bot через MTProto (юзер-сессия), парсит
сообщения (maxswap_parser) и пишет в finance-API — snapshot баланса карты + log_only
события покупок/возвратов. Дедуп/идемпотентность по client_id = tg_<msgId>.

Это «Сигнал 1 (снимок) + Сигнал 2 (поток)» из aggregator-design.md §2 для счёта maxswap.
Always-on слушатель (для VPS) + одноразовый backfill истории.

В live-режиме дополнительно раз в MAXSWAP_BALANCE_POLL_MIN минут (env, дефолт 20)
авточитает баланс карты через backend мини-аппа MaxSwap и пишет снимком (счёт maxswap).

Режимы:
  --backfill            прогнать историю с последнего курсора (или всю) → события в API
  --dry-run             ничего не писать, только печатать планируемые вызовы
  --test-balance        один раз прочитать баланс карты и напечатать (снимок НЕ пишет)
  (без флагов)          live: catch-up с курсора + run_until_disconnected (для VPS)

Примеры:
  scripts/.venv/bin/python scripts/maxswap_listener.py --backfill --dry-run   # превью
  scripts/.venv/bin/python scripts/maxswap_listener.py --backfill             # залить историю
  scripts/.venv/bin/python scripts/maxswap_listener.py --test-balance         # проверка авточтения
  scripts/.venv/bin/python scripts/maxswap_listener.py                        # live (VPS)

Креды/токен из .env: TELEGRAM_API_ID/HASH/SESSION, APP_TOKEN.
Опц. MAXSWAP_BALANCE_POLL_MIN (интервал авточтения баланса). Курсор — scripts/.state/.
"""
import os
import sys
import json
import base64
import asyncio
import urllib.request
import urllib.error
import urllib.parse
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
TEST_BALANCE = "--test-balance" in sys.argv

# Мини-апп MaxSwap: backend авторизации/баланса карты (счёт `maxswap`).
MAXSWAP_MINIAPP_URL = "https://miniapp.my.maxswap.cc/"
MAXSWAP_API_BASE = "https://my.maxswap.cc/api"
# Мини-апп шлёт этот заголовок на оба запроса — без него backend не отвечает как для miniapp.
MAXSWAP_LAUNCH_HEADER = {"x-launch-type": "miniapp"}
HTTP_TIMEOUT = 20


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


# --- Авточтение баланса карты через backend мини-аппа MaxSwap ---
# Последнее записанное снимком значение (в рамках процесса), чтобы не спамить одинаковыми.
_last_card_balance = None


async def get_init_data(client) -> str:
    """Достать СЫРУЮ строку WebApp.initData (query-string) мини-аппа MaxSwap через MTProto.

    Через messages.RequestWebView получаем url открытия мини-аппа; в его fragment лежит
    tgWebAppData=<urlencoded initData>. Извлекаем и unquote → сырой init_data_str.

    Обрабатываем два случая url мини-аппа:
      1) явный url страницы мини-аппа (MAXSWAP_MINIAPP_URL);
      2) меню-кнопка mini-app у бота — берём её url из полного профиля бота.
    Проверяется на живом деплое через --test-balance.
    """
    from telethon.tl.functions.messages import RequestWebViewRequest

    bot = await client.get_entity(BOT)

    # По умолчанию открываем известный url мини-аппа. Если у бота настроена menu-button
    # с mini-app, предпочитаем её url (это «каноничный» вход, как во фронте).
    url = MAXSWAP_MINIAPP_URL
    try:
        from telethon.tl.functions.users import GetFullUserRequest
        full = await client(GetFullUserRequest(bot))
        bot_info = getattr(full.full_user, "bot_info", None)
        menu = getattr(bot_info, "menu_button", None) if bot_info else None
        menu_url = getattr(menu, "url", None)
        if menu_url:
            url = menu_url
    except Exception as e:  # noqa: BLE001 — профиль не критичен, есть дефолтный url
        print(f"[balance] не удалось прочитать menu-button бота ({e}); беру дефолтный url")

    res = await client(RequestWebViewRequest(
        peer=bot, bot=bot, platform="android", url=url,
    ))
    web_url = getattr(res, "url", None)
    if not web_url:
        raise RuntimeError("RequestWebView не вернул url мини-аппа")

    # tgWebAppData обычно в fragment (после '#'); на всякий случай смотрим и query.
    parsed = urllib.parse.urlparse(web_url)
    params = {}
    if parsed.fragment:
        params.update(urllib.parse.parse_qs(parsed.fragment))
    if parsed.query:
        params.update(urllib.parse.parse_qs(parsed.query))
    raw = params.get("tgWebAppData")
    if not raw:
        raise RuntimeError(
            "tgWebAppData не найден в url мини-аппа (проверь на --test-balance)")
    # parse_qs уже сделал один uncode; init_data_str — это сырой query-string initData.
    return raw[0]


def _maxswap_access_token(init_data_str: str) -> str:
    """POST /api/v1/auth/telegram/connect → access_token.

    body {"telegram_hash": <B64>}, x-launch-type: miniapp
    <B64> = base64(json.dumps(init_data_str)) — то же, что btoa(JSON.stringify(initData)) во фронте.
    Секрет (access_token) наружу не логируется.
    """
    # btoa(JSON.stringify(str)): json.dumps строки даёт её в кавычках — так и надо.
    telegram_hash = base64.b64encode(
        json.dumps(init_data_str).encode()).decode()

    connect_body = json.dumps({"telegram_hash": telegram_hash}).encode()
    req = urllib.request.Request(
        MAXSWAP_API_BASE + "/v1/auth/telegram/connect",
        data=connect_body, method="POST",
        headers={"User-Agent": UA, "Accept": "application/json",
                 "Content-Type": "application/json", **MAXSWAP_LAUNCH_HEADER},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            auth = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"connect HTTP {e.code}: {e.read().decode()[:200]}") from None

    access_token = auth.get("access_token")
    if not access_token:
        raise RuntimeError("connect: нет access_token в ответе")
    return access_token


def _maxswap_get(access_token: str, path: str):
    """GET <MAXSWAP_API_BASE><path> с авторизацией мини-аппа → распарсенный JSON."""
    req = urllib.request.Request(
        MAXSWAP_API_BASE + path, method="GET",
        headers={"Authorization": f"Bearer {access_token}",
                 "User-Agent": UA, "Accept": "application/json",
                 **MAXSWAP_LAUNCH_HEADER},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"GET {path} HTTP {e.code}: {e.read().decode()[:200]}") from None


def _cards_list_balance(payload):
    """Сумма balance по картам из ответа /api/v3/cards.

    Структура: {"items": [{..., "balance": "93.72"}, ...], "total": N}.
    Баланс счёта maxswap = сумма balance активных карт (сейчас карта одна).
    Возвращает float, либо None если структура не распознана / карт нет.
    """
    if not isinstance(payload, dict):
        return None
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        return None
    total = 0.0
    found = False
    for card in items:
        if isinstance(card, dict) and card.get("balance") is not None:
            try:
                total += float(card["balance"])
                found = True
            except (TypeError, ValueError):
                pass
    return total if found else None


def _totalbalance_of(payload):
    """totalBalance из /api/v3/cards/balances (top-level или под .data), либо None.

    Проверяем оба уровня — backend может (или не может) заворачивать в конверт `{data: {...}}`.
    spotBalance (спот-кошелёк) — это НЕ карта, на него НЕ фолбэчимся.
    """
    for obj in (payload, payload.get("data") if isinstance(payload, dict) else None):
        if isinstance(obj, dict) and obj.get("totalBalance") is not None:
            try:
                return float(obj["totalBalance"])
            except (TypeError, ValueError):
                pass
    return None


def fetch_card_balance_http(init_data_str: str) -> float:
    """HTTP-запросы backend'а мини-аппа → баланс КАРТЫ (USDT) как float.

    1) POST /api/v1/auth/telegram/connect → access_token.
    2) GET  /api/v3/cards → items[].balance (баланс карты, именно его показывает мини-апп).
       Это источник правды для счёта maxswap. spotBalance из /cards/balances — спот-кошелёк,
       а НЕ карта; на него не смотрим.
    Фолбэк: если /cards пуст/не распознан — пробуем totalBalance из /cards/balances.
    Секреты (access_token/initData) НЕ логируются.
    """
    access_token = _maxswap_access_token(init_data_str)

    bal = _cards_list_balance(_maxswap_get(access_token, "/v3/cards"))
    if bal is not None:
        return bal

    bal = _totalbalance_of(_maxswap_get(access_token, "/v3/cards/balances"))
    if bal is not None:
        return bal

    raise RuntimeError(
        "не удалось извлечь баланс карты (ни /cards items[].balance, "
        "ни /cards/balances totalBalance)")


async def poll_card_balance(client):
    """get_init_data → fetch_card_balance_http → snapshot maxswap (если значение изменилось).

    Изолировано: любая ошибка ЛОГИРУЕТСЯ и проглатывается — не должна ронять листенер.
    Первый успешный прогон пишет снимок всегда; далее — только при изменении.
    """
    global _last_card_balance
    try:
        init_data = await get_init_data(client)
        bal = round(fetch_card_balance_http(init_data), 2)
    except Exception as e:  # noqa: BLE001 — авточтение не должно ронять приём уведомлений
        print(f"[balance] авточтение не удалось: {e}")
        return
    if _last_card_balance is not None and bal == _last_card_balance:
        print(f"[balance] maxswap={bal} без изменений — снимок не пишу")
        return
    try:
        res = run_action({"call": "snapshot", "account": "maxswap", "amount": bal})
        _last_card_balance = bal
        print(f"[balance] {res}")
    except RuntimeError as e:
        print(f"[balance] snapshot ERROR: {e}")


async def balance_scheduler(client):
    """Периодический таск для live-режима: первый прогон ~через 30с, далее раз в N минут."""
    poll_min = int(env("MAXSWAP_BALANCE_POLL_MIN", required=False) or 20)
    await asyncio.sleep(30)
    while True:
        await poll_card_balance(client)
        await asyncio.sleep(poll_min * 60)


async def do_test_balance(client):
    """--test-balance: один раз прочитать баланс карты, НАПЕЧАТАТЬ, снимок НЕ писать.

    Разовая диагностика: печатает сырой JSON обоих балансовых эндпойнтов
    (/cards/balances и /cards) — это не секрет; access_token/initData НЕ печатаются.
    """
    init_data = await get_init_data(client)
    bal = fetch_card_balance_http(init_data)
    print(f"[test-balance] card balance (maxswap) = {bal}")


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

    # Периодическое авточтение баланса карты (снимок maxswap) — изолированный таск.
    asyncio.create_task(balance_scheduler(client))

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

    if TEST_BALANCE:
        await do_test_balance(client)
        await client.disconnect()
        return

    entity = await client.get_entity(BOT)

    if BACKFILL:
        await do_backfill(client, entity)
    else:
        await run_live(client, entity)
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
