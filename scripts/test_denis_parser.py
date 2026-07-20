#!/usr/bin/env python3
"""
Юнит-тесты парсера обмена USDT->THB @denis (scripts/denis_parser.py).

Фикстуры СИНТЕТИЧЕСКИЕ: реальным остаётся только ФОРМАТ строки (структура оффера,
пробелы/NBSP как разделитель тысяч). Суммы/курсы/THB — выдуманы, заведомо отличны
от реальных сделок; UID/имя/username реального человека в фикстурах НЕТ (см. §9 спеки).
Запуск:

    scripts/.venv/bin/python scripts/test_denis_parser.py    # (или просто python3)
"""
import sys
from denis_parser import classify, build_events, _num

PASS = 0
FAIL = 0

NBSP = " "       # U+00A0 non-breaking space
NNBSP = " "      # U+202F narrow non-breaking space


def check(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
    else:
        FAIL += 1
        print(f"  ✗ {name}\n      got:  {got!r}\n      want: {want!r}")


# --- Оффер (обычный, is_out=False) ---
OFFER = ("Вы отдаете: 200 USDT\n"
         "Вы получаете: 6 400 THB\n"
         "Курс обмена: 32.00")
check("offer.basic", classify(OFFER, is_out=False),
      {"kind": "offer", "usdt": 200.0, "thb": 6400, "rate": 32.0})

# --- Оффер с NBSP-разделителем тысяч и дробным USDT ---
OFFER_NBSP = ("Вы отдаете: 100.5 USDT\n"
              f"Вы получаете: 10{NBSP}500 THB\n"
              "Курс обмена: 32.00")
check("offer.nbsp", classify(OFFER_NBSP, is_out=False),
      {"kind": "offer", "usdt": 100.5, "thb": 10500, "rate": 32.0})

# --- Завершения (is_out=True) → {"kind":"completion"} ---
for name, text in [
    ("done.poluchilos", "получилось"),
    ("done.spasibo", "спасибо"),
    ("done.zabral", "забрал"),
    ("done.est_spasibo", "есть, спасибо"),
    ("done.da", "да"),
]:
    check(name, classify(text, is_out=True), {"kind": "completion"})

# --- НЕ-завершения (is_out=True) → None ---
for name, text in [
    ("neg.ne_poluchaetsya", "не получается"),
    ("neg.poedu", "поеду к другому"),
    ("neg.da_ne_poluchilos", "да не получилось"),
]:
    check(name, classify(text, is_out=True), None)

# --- Направление ---
# Оффер, написанный "наоборот" (is_out=True) → None (Даниил офферы не делает).
check("dir.offer_is_out", classify(OFFER, is_out=True), None)
# "спасибо" от обменника (is_out=False, авто-ответ) → НЕ completion.
check("dir.spasibo_incoming", classify("спасибо", is_out=False), None)

# --- Игнор (None) ---
check("ignore.old_format", classify("6400", is_out=False), None)          # старый формат
check("ignore.sim", classify("100 бат на симку", is_out=False), None)     # доп-заказ без оффера
check("ignore.uid", classify(f"💸Bybit UID{NBSP}{NBSP}000000000", is_out=False), None)  # UID-сообщение

# --- Машина событий: build_events ---
PENDING = {"offer_msg_id": 777, "usdt": 200.0, "thb": 6400, "rate": 32.0,
           "offer_ts": "2026-07-20T09:00:00+00:00"}
TS = "2026-07-20T10:00:00+00:00"
ev = build_events(PENDING, TS)
check("build.len", len(ev), 2)
check("build.thb.leg", ev[0], {"call": "event", "body": {
    "type": "income", "to": "cash", "amount": 6400,
    "note": "обмен USDT→THB @denis, курс 32.0",
    "log_only": False, "at": TS, "client_id": "tg_denis_777_thb"}})
check("build.usdt.leg", ev[1], {"call": "event", "body": {
    "type": "expense", "from": "bybit", "amount": 200.0,
    "note": "обмен USDT→THB @denis, курс 32.0 (bybit→UID)",
    "log_only": True, "at": TS, "client_id": "tg_denis_777_usdt"}})
check("build.thb.client_id", ev[0]["body"]["client_id"], "tg_denis_777_thb")
check("build.usdt.client_id", ev[1]["body"]["client_id"], "tg_denis_777_usdt")
check("build.thb.log_only", ev[0]["body"]["log_only"], False)
check("build.usdt.log_only", ev[1]["body"]["log_only"], True)
check("build.thb.at", ev[0]["body"]["at"], TS)
check("build.usdt.at", ev[1]["body"]["at"], TS)
check("build.client_id_len", max(len(ev[0]["body"]["client_id"]),
                                 len(ev[1]["body"]["client_id"])) <= 64, True)

# --- Два обмена подряд: изоляция client_id и сумм ---
TS1 = "2026-07-20T11:00:00+00:00"
TS2 = "2026-07-20T15:00:00+00:00"
a = build_events({"offer_msg_id": 111, "usdt": 200.0, "thb": 6400, "rate": 32.0,
                  "offer_ts": "2026-07-20T10:30:00+00:00"}, TS1)
b = build_events({"offer_msg_id": 222, "usdt": 100.0, "thb": 3200, "rate": 32.0,
                  "offer_ts": "2026-07-20T14:30:00+00:00"}, TS2)
cids = {a[0]["body"]["client_id"], a[1]["body"]["client_id"],
        b[0]["body"]["client_id"], b[1]["body"]["client_id"]}
check("two.client_ids_distinct", len(cids), 4)
check("two.client_ids_values", cids,
      {"tg_denis_111_thb", "tg_denis_111_usdt", "tg_denis_222_thb", "tg_denis_222_usdt"})
check("two.a.thb", a[0]["body"]["amount"], 6400)
check("two.a.usdt", a[1]["body"]["amount"], 200.0)
check("two.b.thb", b[0]["body"]["amount"], 3200)
check("two.b.usdt", b[1]["body"]["amount"], 100.0)

# --- _num: нормализатор чисел (синтетические, не-сделочные суммы той же формы) ---
check("num.space", _num("9 900"), 9900.0)          # обычный пробел
check("num.nbsp", _num(f"9{NBSP}900"), 9900.0)     # NBSP U+00A0
check("num.nnbsp", _num(f"9{NNBSP}900"), 9900.0)   # narrow NBSP U+202F
check("num.int", _num("250"), 250.0)
check("num.frac", _num("250.5"), 250.5)
check("num.frac_comma", _num("250,5"), 250.5)      # запятая-десятичная → точка

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
