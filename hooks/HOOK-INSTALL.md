# SessionStart hook для авто-pull при старте Claude Code

Чтобы каждая Claude-сессия начиналась со свежего файла трат — добавь хук в `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "/mnt/d/proj/my-finans/hooks/session-start.sh" }
        ]
      }
    ]
  }
}
```

Если в `settings.json` уже есть секция `hooks` — добавь только запись `SessionStart` внутрь.

Хук молчит при любом исходе (успех/нет сети/нет репо) — не мешает старту сессии. Логов нет: pull прозрачный, проверить можно через `git log --oneline | head -5` в репо после старта.
