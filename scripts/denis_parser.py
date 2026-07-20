#!/usr/bin/env python3
"""
Чистый парсер + машина событий обмена USDT->THB у P2P-обменника @denis.

Никакого I/O и сети: на вход — текст одного сообщения диалога и направление
(`is_out`), на выход — dict (или None). Отдельно `build_events` собирает пару
action-dict для `run_action` листенера. Всё чистое → тестируется на фикстурах
(как parseExpense в api/src/index.js и maxswap_parser.py).

Модель (см. docs/private/specs/denis-exchange-listener.md):
- Оффер приходит ОТ обменника (is_out == False) тремя строками:
  «Вы отдаете: <USDT> USDT / Вы получаете: <THB> THB / Курс обмена: <rate>».
- Завершение пишет Даниил (is_out == True) короткой репликой из словаря.
- Один завершённый обмен = ПАРА событий:
    THB-нога  — income to:cash,  log_only=False (реальный приход батов);
    USDT-нога — expense from:bybit, log_only=True (история/курс, баланс ведёт поллер).
  Связка/идемпотентность — через корень client_id `tg_denis_<offer_msg_id>`.

Форматы взяты из живого дампа. Все числа/идентификаторы человека — вне этого модуля.
"""
import re
from datetime import datetime, timedelta

# Виды пробелов, встречающихся как разделитель тысяч: обычный, NBSP, narrow NBSP.
_SPACE_CHARS = "   "

# --- Оффер (только is_out == False). re.M — строки внутри многострочного сообщения. ---
# Число может содержать пробелы/NBSP/narrow-NBSP как разделитель тысяч и десятичную «,»/«.».
OFFER_USDT_RE = re.compile(r'^Вы отдаете:[ \t  ]*([\d \t  .,]+?)[ \t  ]*USDT', re.M)
OFFER_THB_RE = re.compile(r'^Вы получаете:[ \t  ]*([\d \t  .]+?)[ \t  ]*THB', re.M)
OFFER_RATE_RE = re.compile(r'^Курс обмена:[ \t  ]*([\d.,]+)', re.M)

# --- Завершение (только is_out == True). ---
# Корни завершения — засчитываются ТОЛЬКО как отдельное слово (startswith по словам).
COMPLETION_ROOTS = ("получ", "забрал", "спасибо")
# Точные однословные сигналы (совпадение всего нормализованного сообщения целиком).
COMPLETION_EXACT = ("да", "есть")
# Стоп-лист отрицаний — проверяется ПЕРВЫМ, имеет приоритет NO-completion.
NEGATION_RE = [
    re.compile(r'не\s+получ'),
    re.compile(r'не\s+вышло'),
    re.compile(r'не\s+получается'),
    re.compile(r'не\s+смог'),
    re.compile(r'поеду'),
    re.compile(r'другой банкомат'),
]


def _num(s):
    """Нормализатор числа из оффера → float.

    Удаляет обычный пробел, NBSP (U+00A0) и narrow NBSP (U+202F) — все варианты
    разделителя тысяч, — меняет десятичную «,» на «.» и приводит к float.
    Примеры: «4 800»->4800.0, «4[NBSP]800»->4800.0, «150»->150.0, «150,5»->150.5.
    """
    t = (s.replace(" ", "")
          .replace(" ", "")
          .replace(" ", "")
          .replace(",", "."))
    return float(t)


def _classify_offer(text):
    m_usdt = OFFER_USDT_RE.search(text)
    m_thb = OFFER_THB_RE.search(text)
    m_rate = OFFER_RATE_RE.search(text)
    # Оффер валиден, только если распознаны все три поля.
    if not (m_usdt and m_thb and m_rate):
        return None
    return {
        "kind": "offer",
        "usdt": _num(m_usdt.group(1)),          # USDT может быть дробным
        "thb": int(_num(m_thb.group(1))),       # THB — целые
        "rate": _num(m_rate.group(1)),
    }


def _normalize_completion(text):
    """trim, lower, схлопнуть внутренние пробелы (в т.ч. NBSP), снять финальную пунктуацию."""
    t = text.replace(" ", " ").replace(" ", " ")
    t = t.strip().lower()
    t = re.sub(r"\s+", " ", t)
    t = t.rstrip(" .,!?…")
    return t


def _classify_completion(text):
    # (1) нормализация
    norm = _normalize_completion(text)
    if not norm:
        return None
    # (2) стоп-лист отрицаний — ПЕРВЫМ
    for rx in NEGATION_RE:
        if rx.search(norm):
            return None
    words = norm.split()
    # (3) матч корня — ТОЛЬКО пословно (startswith), не подстрокой по фразе
    if any(w.startswith(root) for w in words for root in COMPLETION_ROOTS):
        return {"kind": "completion"}
    # (4) «да»/«есть» — только точное совпадение всего сообщения
    if norm in COMPLETION_EXACT:
        return {"kind": "completion"}
    # (5) иначе — нерелевантно
    return None


def classify(text, is_out):
    """Классифицировать одно сообщение диалога с обменником.

    is_out=True  → сообщение Даниила (может быть сигналом завершения).
    is_out=False → сообщение обменника (может быть оффером).
    Возвращает:
      {"kind": "offer", "usdt": float, "thb": int, "rate": float}
      {"kind": "completion"}
      None  (нерелевантно / промежуточное).

    Направление жёстко разделяет типы: оффер — только при is_out==False,
    завершение — только при is_out==True. Оффер, написанный «наоборот»
    (is_out==True), и авто-ответ обменника (is_out==False) → None.
    """
    if not text:
        return None
    if is_out:
        # Оффер, написанный "наоборот" (is_out==True), — не завершение: Даниил
        # офферы не пишет, а трёхстрочная структура оффера содержит слово
        # «получаете», которое иначе матчнуло бы корень завершения «получ».
        if _classify_offer(text) is not None:
            return None
        return _classify_completion(text)
    return _classify_offer(text)


def build_events(pending, completion_ts):
    """pending (сырой оффер) + timestamp завершения → [THB-action, USDT-action].

    Формат элемента совместим с run_action листенера: {"call": "event", "body": {...}}.
    Порядок фиксирован: сперва THB-нога (реальный приход), затем USDT-нога (log_only).
    currency НЕ передаём — для income to:cash валюта берётся из листа Balances.
    Без сети.
    """
    msg_id = pending["offer_msg_id"]
    usdt = pending["usdt"]
    thb = pending["thb"]
    rate = pending["rate"]
    note = f"обмен USDT→THB @denis, курс {rate}"
    thb_action = {"call": "event", "body": {
        "type": "income",
        "to": "cash",
        "amount": thb,
        "note": note,
        "log_only": False,
        "at": completion_ts,
        "client_id": f"tg_denis_{msg_id}_thb",
    }}
    usdt_action = {"call": "event", "body": {
        "type": "expense",
        "from": "bybit",
        "amount": usdt,
        "note": f"{note} (bybit→UID)",
        "log_only": True,
        "at": completion_ts,
        "client_id": f"tg_denis_{msg_id}_usdt",
    }}
    return [thb_action, usdt_action]


def _to_dt(value):
    """Привести aware datetime | ISO-строку к datetime. Внутренний хелпер TTL."""
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def _pending_expired(pending, now):
    """TTL: возраст pending > 24 ч → протух (сделка сорвалась).

    Чистая функция, без I/O. `now` и `pending['offer_ts']` принимаются как aware
    datetime ЛИБО ISO-8601-строка (например '2026-07-20T09:12:00+00:00') —
    оба нормализуются через datetime.fromisoformat. Пустой pending → False
    (нечему протухать). Обе величины должны быть в согласованных tz (обе aware).
    """
    if not pending:
        return False
    offer_dt = _to_dt(pending["offer_ts"])
    now_dt = _to_dt(now)
    return now_dt - offer_dt > timedelta(hours=24)
