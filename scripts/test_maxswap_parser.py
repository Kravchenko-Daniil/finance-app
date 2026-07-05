#!/usr/bin/env python3
"""
Юнит-тесты парсера MaxSwap (scripts/maxswap_parser.py). Фикстуры СИНТЕТИЧЕСКИЕ —
форматы повторяют живой дамп, но мерчанты/суммы/хэши выдуманы (реальные финданные
в репо не кладём). Запуск:

    scripts/.venv/bin/python scripts/test_maxswap_parser.py   # (или просто python3)
"""
import sys
from maxswap_parser import parse_message, message_to_actions

PASS = 0
FAIL = 0


def check(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
    else:
        FAIL += 1
        print(f"  ✗ {name}\n      got:  {got!r}\n      want: {want!r}")


# --- Покупка OK ---
PURCHASE = ("✅ Покупка на сумму 12.34 USDT у COFFEE SHOP BANGKOK THA прошла успешно\n"
            "Текущий баланс: 87.66 USDT")
p = parse_message(PURCHASE)
check("purchase.kind", p["kind"], "purchase")
check("purchase.amount", p["amount"], 12.34)
check("purchase.merchant", p["merchant"], "COFFEE SHOP BANGKOK THA")
check("purchase.card_balance", p["card_balance"], 87.66)
acts = message_to_actions(p, 1001, "2026-06-19T05:00:00+00:00")
check("purchase.actions.len", len(acts), 2)
check("purchase.snapshot", acts[0], {"call": "snapshot", "account": "maxswap", "amount": 87.66})
check("purchase.event", acts[1], {"call": "event", "body": {
    "type": "expense", "from": "maxswap", "amount": 12.34, "note": "COFFEE SHOP BANGKOK THA",
    "log_only": True, "at": "2026-06-19T05:00:00+00:00", "client_id": "tg_1001"}})

# --- Покупка с «*» и смешанным регистром в мерчанте ---
p2 = parse_message("✅ Покупка на сумму 5.0 USDT у Foo * BarBaz Mountain View USA прошла успешно\n"
                   "Текущий баланс: 1.5 USDT")
check("purchase2.merchant", p2["merchant"], "Foo * BarBaz Mountain View USA")
check("purchase2.amount", p2["amount"], 5.0)

# --- Покупка на 0 USDT (пре-авторизация / temporary hold) → снимок без события ---
HOLD = ("✅ Покупка на сумму 0 USDT у GOOGLE *TEMPORARY HOLD LONDON GBR прошла успешно\n"
        "Текущий баланс: 11.04 USDT")
h = parse_message(HOLD)
check("hold.kind", h["kind"], "purchase")
check("hold.amount", h["amount"], 0.0)
ha = message_to_actions(h, 1009, "2026-06-19T09:00:00+00:00")
check("hold.actions.len", len(ha), 1)  # только снимок, события НЕТ
check("hold.snapshot", ha[0], {"call": "snapshot", "account": "maxswap", "amount": 11.04})

# --- Возврат ---
REFUND = ("🔁 Сумма 4.68 USDT от Some Service Mountain View USA была возвращена\n"
          "Текущий баланс: 15.98 USDT")
r = parse_message(REFUND)
check("refund.kind", r["kind"], "refund")
check("refund.amount", r["amount"], 4.68)
check("refund.merchant", r["merchant"], "Some Service Mountain View USA")
ra = message_to_actions(r, 1002, "2026-06-19T06:00:00+00:00")
check("refund.snapshot", ra[0], {"call": "snapshot", "account": "maxswap", "amount": 15.98})
check("refund.event", ra[1], {"call": "event", "body": {
    "type": "income", "to": "maxswap", "amount": 4.68, "note": "возврат: Some Service Mountain View USA",
    "log_only": True, "at": "2026-06-19T06:00:00+00:00", "client_id": "tg_1002"}})

# --- Пополнение карты ---
TOPUP = "💰 Баланс карты 1022 пополнен: 110 USDT\nТекущий баланс: 115.98 USDT"
t = parse_message(TOPUP)
check("topup.kind", t["kind"], "card_topup")
check("topup.card", t["card"], "1022")
check("topup.amount", t["amount"], 110.0)
check("topup.card_balance", t["card_balance"], 115.98)
ta = message_to_actions(t, 1003, "2026-06-19T07:00:00+00:00")
check("topup.actions.len", len(ta), 1)  # только снимок, без события
check("topup.snapshot", ta[0], {"call": "snapshot", "account": "maxswap", "amount": 115.98})

# --- Покупка отклонена ---
DECLINED = ("🚫 Покупка на сумму 29 USDT у SOME STORE KNOXVILLE USA была отклонена\n\n"
            "Card-You have exceeded the cumulative amount limit for this card.\n"
            "Текущий баланс: 13.37 USDT")
d = parse_message(DECLINED)
check("declined.kind", d["kind"], "declined")
check("declined.amount", d["amount"], 29.0)
check("declined.card_balance", d["card_balance"], 13.37)
da = message_to_actions(d, 1004, "2026-06-19T08:00:00+00:00")
check("declined.actions.len", len(da), 1)  # синк баланса, без траты
check("declined.snapshot", da[0], {"call": "snapshot", "account": "maxswap", "amount": 13.37})

# --- Депозит Спота ---
DEPOSIT = ("Операция: Пополнить\n"
           "Заявка ID: 119-792614901824\n"
           "Валюта пополнения: USDT\n"
           "Тип: USDT Solana\n"
           "Объем поступления: 320 USDT\n"
           "Комиссия: 0.0 USDT\n"
           "Объем начисления: 320.0 USDT\n"
           "Статус: Проведен\n"
           "Транзакция: zFAKEhashFAKEhashFAKEhash123\n"
           "Дата транзакции: 07 June 2026, 01:04:32")
dep = parse_message(DEPOSIT)
check("deposit.kind", dep["kind"], "spot_deposit")
check("deposit.amount", dep["amount"], 320.0)
check("deposit.tx_hash", dep["tx_hash"], "zFAKEhashFAKEhashFAKEhash123")
check("deposit.request_id", dep["request_id"], "119-792614901824")
check("deposit.status", dep["status"], "Проведен")
check("deposit.actions", message_to_actions(dep, 1005, "2026-06-07T01:04:32+00:00"), [])  # v1 отложено

# --- Шум: должен парситься как None ---
for noise_name, noise in [
    ("wallet_dump", "💰 Кошелек"),
    ("wallet_coins", "USDT: 487.52\nUSDC: 0.00\n\nBTC: 0.0\nETH: 0.0\nTON: 1.0"),
    ("button_state", "Выбрано: Пополнить\nВыберите валюту баланса, которую желаете пополнить"),
    ("promo", "💳 Новые карты в MaxSwap!\n\nМы добавили 2 новые карты."),
    ("maintenance", "Уважаемые пользователи!\n\nСообщаем, что будет проводиться обновление."),
    ("empty", ""),
    ("none", None),
]:
    check(f"noise.{noise_name}", parse_message(noise), None)
    check(f"noise.{noise_name}.actions", message_to_actions(parse_message(noise), 9, "x"), [])

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
