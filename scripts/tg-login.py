#!/usr/bin/env python3
"""
Одноразовый логин в Telegram юзер-сессией → печатает TELEGRAM_SESSION (StringSession).

Зачем: MaxSwap-листенер читает СВОЙ диалог с ботом через MTProto (юзер-клиент, не Bot
API — чужого бота Bot API не прочитать). Для этого нужна сохранённая сессия. Этот скрипт
проводит интерактивный логин ОДИН раз и выдаёт портируемую строку сессии, которую кладём
в .env как TELEGRAM_SESSION (и потом тот же секрет — в окружение VPS).

Запуск (интерактивный — спросит номер, код из Telegram, при 2FA — пароль; всё вводится
в терминал, в stdout/контекст НЕ попадает):

    scripts/.venv/bin/python scripts/tg-login.py

⚠️ Строка сессии = ПОЛНЫЙ доступ к аккаунту, секрет уровня пароля. Никогда в git, только
в .env (gitignored). После логина скопировать выведенную строку в .env.
"""
import os
import sys

ENV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def env(key):
    try:
        with open(ENV) as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        sys.exit(f".env не найден: {ENV}")
    sys.exit(f"{key} не найден в .env — добавь TELEGRAM_API_ID / TELEGRAM_API_HASH "
             "(значения из my.telegram.org → API development tools).")


def main():
    try:
        from telethon.sync import TelegramClient
        from telethon.sessions import StringSession
    except ImportError:
        sys.exit("Telethon не установлен. Запусти: scripts/.venv/bin/pip install telethon")

    api_id = env("TELEGRAM_API_ID")
    api_hash = env("TELEGRAM_API_HASH")
    try:
        api_id = int(api_id)
    except ValueError:
        sys.exit("TELEGRAM_API_ID должен быть числом.")

    print("Логинимся в Telegram. Сейчас спросит номер телефона и код из приложения "
          "(и пароль, если включена 2FA).\n", file=sys.stderr)

    with TelegramClient(StringSession(), api_id, api_hash) as client:
        me = client.get_me()
        session = client.session.save()
        print(f"\n✅ Залогинен как: {me.first_name} (@{me.username}) id={me.id}",
              file=sys.stderr)
        print("\n=== СКОПИРУЙ ЭТУ СТРОКУ В .env КАК TELEGRAM_SESSION ===\n", file=sys.stderr)
        # Сама строка — в stdout (одна строка, удобно перенаправить/скопировать).
        print(session)
        print("\n(строка выше — секрет уровня пароля, не коммить, не пересылай)",
              file=sys.stderr)


if __name__ == "__main__":
    main()
