#!/usr/bin/env python3
"""
Хелпер для работы с finance-трекером из Claude-сессии.

Читает APP_TOKEN локально из .env (в stdout токен НЕ попадает),
ходит в API с браузерным User-Agent (иначе Cloudflare режет
"ботовый" запрос с ошибкой 1010).

Примеры:
  python3 scripts/fin.py balances
  python3 scripts/fin.py events
  python3 scripts/fin.py events --type expense --limit 50
  python3 scripts/fin.py day 2026-06-06
  python3 scripts/fin.py expense "кофе 350"
  python3 scripts/fin.py event '{"type":"income","to":"bybit","amount":1946,"note":"ЗП"}'
  python3 scripts/fin.py raw GET /api/balances
  python3 scripts/fin.py raw DELETE /api/event/last
"""
import sys, os, json, urllib.request, urllib.error

BASE = "https://finance.daniilkravchenko.com/api"
# Браузерный UA обязателен — без него Cloudflare WAF отдаёт 403 / error 1010.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
ENV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def token():
    with open(ENV) as f:
        for line in f:
            if line.startswith("APP_TOKEN"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("APP_TOKEN не найден в .env")


def req(method, path, body=None):
    # path может прийти как "http...", "/api/balances" или "balances" — нормализуем к BASE (BASE уже оканчивается на /api)
    if path.startswith("http"):
        url = path
    else:
        p = path.strip("/")
        if p.startswith("api/"):
            p = p[4:]
        url = BASE + "/" + p
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token()}",
        "User-Agent": UA,
        "Accept": "application/json",
        "Content-Type": "application/json",
    })
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code}: {e.read().decode()[:300]}")


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main():
    a = sys.argv[1:]
    if not a:
        out(req("GET", "/api/balances")); return
    cmd = a[0]
    if cmd == "balances":
        out(req("GET", "/api/balances"))
    elif cmd == "events":
        q = []
        if "--type" in a:  q.append("type=" + a[a.index("--type") + 1])
        if "--limit" in a: q.append("limit=" + a[a.index("--limit") + 1])
        out(req("GET", "/api/events" + ("?" + "&".join(q) if q else "")))
    elif cmd == "day":
        out(req("GET", "/api/day" + (f"?date={a[1]}" if len(a) > 1 else "")))
    elif cmd == "expense":
        out(req("POST", "/api/expense", {"text": a[1]}))
    elif cmd == "event":
        out(req("POST", "/api/event", json.loads(a[1])))
    elif cmd == "raw":
        out(req(a[1].upper(), a[2], json.loads(a[3]) if len(a) > 3 else None))
    else:
        sys.exit(f"Неизвестная команда: {cmd}\n{__doc__}")


if __name__ == "__main__":
    main()
