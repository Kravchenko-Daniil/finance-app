#!/usr/bin/env python3
"""
Чистый парсер сообщений MaxSwap-бота → структурные действия для finance-API.

Никакого I/O: текст сообщения на вход, dict (или None) на выход; отдельно —
маппинг разобранного сообщения в список вызовов API (snapshot / event). Так
парсер тестируется на фикстурах без сети (как parseExpense в api/src/index.js).

Модель: счёт трекера `maxswap` = баланс КАРТЫ (а не Спота). Каждое сообщение бота
с «Текущий баланс: Y» — авторитетный снимок баланса карты (snapshot, дрейф невозможен).
Покупки/возвраты дополнительно пишутся log_only-событием для аналитики (баланс уже
ведётся снимком, мутировать его событием нельзя — иначе двойной счёт).

Форматы взяты из живого дампа диалога (scripts/maxswap-explore.py), не из пересказа.
"""
import re

# --- Якоря типов сообщений (^…, re.M — строки внутри многострочного сообщения) ---
PURCHASE_OK_RE = re.compile(r'^✅ Покупка на сумму ([\d.]+) USDT у (.+?) прошла успешно', re.M)
REFUND_RE = re.compile(r'^🔁 Сумма ([\d.]+) USDT от (.+?) была возвращена', re.M)
CARD_TOPUP_RE = re.compile(r'^💰 Баланс карты (\d+) пополнен: ([\d.]+) USDT', re.M)
PURCHASE_DECLINED_RE = re.compile(r'^🚫 Покупка на сумму ([\d.]+) USDT у (.+?) была отклонена', re.M)
BALANCE_RE = re.compile(r'Текущий баланс: ([\d.]+) USDT')

# Депозит Спота (on-chain приход). Многострочный блок «Операция: Пополнить».
SPOT_OP_RE = re.compile(r'^Операция: Пополнить\b', re.M)
SPOT_CREDIT_RE = re.compile(r'^Объем начисления: ([\d.]+) USDT', re.M)
SPOT_TXID_RE = re.compile(r'^Транзакция: (\S+)', re.M)
SPOT_REQID_RE = re.compile(r'^Заявка ID: (\S+)', re.M)
SPOT_STATUS_RE = re.compile(r'^Статус: (.+?)\s*$', re.M)

ACCOUNT = "maxswap"  # счёт-карта MaxSwap в трекере (USDT)


def _f(s):
    return round(float(s), 2)


def parse_message(text):
    """Текст сообщения бота → структурный dict, либо None если сообщение нерелевантно.

    Возвращаемые kind: purchase | refund | card_topup | declined | spot_deposit.
    Поле card_balance (если есть) — авторитетный снимок баланса карты.
    """
    if not text:
        return None

    bal = BALANCE_RE.search(text)
    card_balance = _f(bal.group(1)) if bal else None

    m = PURCHASE_OK_RE.search(text)
    if m:
        return {"kind": "purchase", "amount": _f(m.group(1)),
                "merchant": m.group(2).strip(), "card_balance": card_balance}

    m = REFUND_RE.search(text)
    if m:
        return {"kind": "refund", "amount": _f(m.group(1)),
                "merchant": m.group(2).strip(), "card_balance": card_balance}

    m = CARD_TOPUP_RE.search(text)
    if m:
        return {"kind": "card_topup", "card": m.group(1),
                "amount": _f(m.group(2)), "card_balance": card_balance}

    m = PURCHASE_DECLINED_RE.search(text)
    if m:
        return {"kind": "declined", "amount": _f(m.group(1)),
                "merchant": m.group(2).strip(), "card_balance": card_balance}

    if SPOT_OP_RE.search(text):
        credit = SPOT_CREDIT_RE.search(text)
        txid = SPOT_TXID_RE.search(text)
        reqid = SPOT_REQID_RE.search(text)
        status = SPOT_STATUS_RE.search(text)
        return {"kind": "spot_deposit",
                "amount": _f(credit.group(1)) if credit else None,
                "tx_hash": txid.group(1) if txid else None,
                "request_id": reqid.group(1) if reqid else None,
                "status": status.group(1).strip() if status else None,
                "card_balance": None}

    return None


def message_to_actions(parsed, msg_id, at_iso, account=ACCOUNT):
    """Разобранное сообщение → список API-вызовов (чистые dict, без сети).

    Каждый элемент: {"call": "snapshot", "account", "amount"} или
                    {"call": "event", "body": {...}}.
    Листенер просто исполняет их по порядку. client_id = tg_<msgId> → дедуп/идемпотентность.
    """
    if not parsed:
        return []

    kind = parsed["kind"]
    actions = []

    # Любое сообщение с «Текущий баланс» — авторитетный снимок карты.
    if parsed.get("card_balance") is not None:
        actions.append({"call": "snapshot", "account": account,
                        "amount": parsed["card_balance"]})

    cid = f"tg_{msg_id}"

    # amount==0 → пре-авторизация / temporary hold (проверка карты): баланс не двигает,
    # не трата. Снимок баланса оставляем, событие НЕ создаём (и API отверг бы amount=0).
    if kind == "purchase" and parsed["amount"] > 0:
        actions.append({"call": "event", "body": {
            "type": "expense", "from": account, "amount": parsed["amount"],
            "note": parsed["merchant"], "log_only": True,
            "at": at_iso, "client_id": cid}})
    elif kind == "refund" and parsed["amount"] > 0:
        actions.append({"call": "event", "body": {
            "type": "income", "to": account, "amount": parsed["amount"],
            "note": f"возврат: {parsed['merchant']}", "log_only": True,
            "at": at_iso, "client_id": cid}})
    # card_topup / declined → только снимок (внутр. движение / синк баланса), без события.
    # spot_deposit → v1 отложено (Спот не трекается; пригодится ститчеру переводов §4-5).

    return actions
