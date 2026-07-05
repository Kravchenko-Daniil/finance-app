#!/usr/bin/env python3
"""
Разведка диалога с MaxSwap-ботом через MTProto. Только чтение — печатает последние N
сообщений из диалога ДОСЛОВНО, чтобы по реальным форматам построить парсер листенера
(дизайн-док §5 их лишь пересказывает — этого мало для надёжного разбора).

Аналог bybit-explore.mjs, но для Telegram. Креды и сессия из .env (TELEGRAM_API_ID,
TELEGRAM_API_HASH, TELEGRAM_SESSION). Сессию выдаёт scripts/tg-login.py.

Запуск:
    scripts/.venv/bin/python scripts/maxswap-explore.py [bot_username] [limit]
    scripts/.venv/bin/python scripts/maxswap-explore.py MaxSwap_bot 60

⚠️ Выводит реальные суммы/операции из чата с ботом — это твои финансовые данные.
Запускать локально; вывод не коммить.
"""
import os
import sys

ENV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


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


def main():
    # --classify: прогнать каждое сообщение через парсер и показать, как оно
    # классифицируется (kind + число API-действий) — валидация парсера на ЖИВЫХ данных
    # без их сохранения. Без флага — обычный дословный дамп.
    argv = [a for a in sys.argv[1:] if a != "--classify"]
    classify = "--classify" in sys.argv
    bot = argv[0] if len(argv) > 0 else "MaxSwap_bot"
    limit = int(argv[1]) if len(argv) > 1 else 60

    parse_message = message_to_actions = None
    if classify:
        from maxswap_parser import parse_message, message_to_actions

    try:
        from telethon.sync import TelegramClient
        from telethon.sessions import StringSession
    except ImportError:
        sys.exit("Telethon не установлен: scripts/.venv/bin/pip install telethon")

    api_id = int(env("TELEGRAM_API_ID"))
    api_hash = env("TELEGRAM_API_HASH")
    session = env("TELEGRAM_SESSION")

    with TelegramClient(StringSession(session), api_id, api_hash) as client:
        try:
            entity = client.get_entity(bot)
        except Exception as e:  # noqa: BLE001
            sys.exit(f"Не нашёл диалог '{bot}': {e}\n"
                     "Проверь username (без @) или открой диалог в Telegram хотя бы раз.")

        title = getattr(entity, "username", None) or getattr(entity, "first_name", bot)
        print(f"=== Диалог: {title} (id={entity.id}) — последние {limit} сообщений ===\n")

        msgs = list(client.iter_messages(entity, limit=limit))
        msgs.reverse()  # старые сверху, как в логе Events
        for m in msgs:
            who = "→OUT" if m.out else "IN  "
            date = m.date.astimezone().strftime("%Y-%m-%d %H:%M") if m.date else "?"
            flags = []
            if m.media:
                flags.append(f"media={type(m.media).__name__}")
            if m.buttons:
                flags.append("buttons")
            flag_s = (" [" + ", ".join(flags) + "]") if flags else ""
            text = m.message or ""
            if classify:
                parsed = parse_message(text)
                kind = parsed["kind"] if parsed else "—"
                nact = len(message_to_actions(parsed, m.id, "x")) if parsed else 0
                first = text.splitlines()[0] if text else "(нет текста)"
                print(f"id={m.id} {who} {date}  kind={kind:<13} actions={nact}  | {first[:70]}")
            else:
                print(f"--- msg id={m.id} {who} {date}{flag_s} ---")
                print(text if text else "(нет текста)")
                print()


if __name__ == "__main__":
    main()
