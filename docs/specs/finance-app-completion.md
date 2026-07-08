# Plan: Довести finance-app до рабочего продукта

## Task Description
Трекер трат (сайт + Worker API + Google Sheets) работает как базовый механизм захвата,
но авто-сбор балансов доделан наполовину, а балансы в таблице разошлись с реальностью.
Задача — закрыть дыры, из-за которых балансы врут, и сделать так, чтобы основные деньги
читались сами и точно.

Тип: enhancement + feature (крипто-поллер — новый компонент). Сложность: medium.

## Objective
По завершении:
- Балансы в таблице отражают реальность на сегодня (разовый снимок).
- Основные деньги (крипта: trustwallet + bybit) читаются автоматически, как ZenMoney/MaxSwap.
- Быстрая трата без валютного токена попадает в наличку (THB), а не во вьетнамский счёт.
- Система сама сигналит, когда источник ослеп (как ZenMoney, молчавший 2 недели незамеченным).

## Problem Statement
Три класса проблем, установленных живой разведкой 2026-07-05:

1. **Крипта не читается никем.** Поллера для trustwallet (Tron) и bybit нет. Итог: реальные
   1 667 USDT в trustwallet стояли нулём в таблице, bybit показывал 100.93 при реальном 0.
   Это основная часть капитала пользователя — и именно она вне авто-сбора.
2. **Дрейф таблицы.** `updated_at` = 24 июня. trustwallet, bybit, дебеты РФ разошлись с жизнью.
3. **Слепые зоны без сигнала.** ZenMoney 2 недели не синкал банки — пользователь узнал случайно.
   Основной счёт стоит на Вьетнаме (VND), хотя траты идут наличкой в THB. Наличные траты не
   попадают в систему вообще.

## Solution Approach
- **Снимок сейчас** (ручной разовый POST /api/snapshot) — выправить сегодняшнюю картину.
- **Крипто-поллер** по образцу `scripts/zenmoney-poller.mjs`: балансы trustwallet/bybit —
  `zenmoney`-authority-подобны (баланс источника точный, snapshot напрямую, без anchor/offset).
  Cron на VPS рядом с ZenMoney. v1 — только снимок баланса (Сигнал 1); операции (депозиты/
  выводы, ститчинг переводов) — отдельный поздний шаг.
- **primary → cash/THB** — правка листа Settings, без деплоя.
- **Watchdog** — следит за свежестью данных (`Balances.updated_at`, поле `changed` счёта в
  ZenMoney), а НЕ за тем, жив ли процесс поллера (поллер был жив и давал «новых 0», пока
  источник молчал). Пингует при устаревании.

Все записи балансов/операций — ТОЛЬКО через API (`POST /api/snapshot`, `POST /api/event`),
не прямой записью в Sheets.

## Relevant Files
- `scripts/zenmoney-poller.mjs` — эталон поллера: `.env`-креды, `.state/*.json`, snapshot через
  `POST /api/snapshot`, retry/backoff, UA-обход Cloudflare WAF. Крипто-поллер копирует структуру.
- `scripts/bybit-explore.mjs` — готовая read-only логика bybit V5 (HMAC `timestamp+apiKey+recvWindow+query`),
  эндпойнт `/v5/account/wallet-balance` (accountType=UNIFIED). Основа bybit-части поллера.
- `scripts/_lib.mjs` — общие хелперы (не для API-записи, но для формата скриптов).
- `api/src/index.js` — `applySnapshot` (SET, all-or-nothing, не трогает лог), `readSettings`
  (primary_account), `readBalances`. Менять НЕ нужно для A1–A3; читать для понимания контракта.
- `api/wrangler.toml` — `PRIMARY_ACCOUNT=bidv` (fallback; лист Settings приоритетнее).
- `scripts/import-bidv.py` — готовый идемпотентный импорт выписки BIDV (D1), есть DRY_RUN.
- `docs/private/aggregator-design.md` §2 (снимок+поток), §12 (watchdog) — модель.
- `CLAUDE.md` — отстаёт (log_only/hidden описаны как pending, а они в проде) — D2.

### New Files
- `scripts/crypto-poller.mjs` — снимок балансов trustwallet (Tron) + bybit → `POST /api/snapshot`.
- `scripts/crypto-poller.service` **или** строка в crontab на VPS — запуск по расписанию.
- `scripts/watchdog.mjs` — проверка свежести балансов, пуш при устаревании (Phase 3).

## Implementation Phases
### Phase 1: Foundation (минуты, чинит «сегодня»)
A3 (primary→cash), A2 (разовый снимок реальных чисел). Требует от пользователя число налички.

### Phase 2: Core Implementation (разработка)
A1 — крипто-поллер trustwallet+bybit, dry-run, деплой cron на VPS.

### Phase 3: Integration & Polish
C1 (watchdog), B1 (решение по наличке), D1 (импорт BIDV вхолостую), D2 (обновить CLAUDE.md).

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. A3 — Основной счёт → cash (THB)
- В листе `Settings` таблицы выставить `C3 = cash` (dropdown), `C4 = THB` (dropdown).
- Проверить: `GET /api/balances` возвращает `primary: "cash"`, `primary_currency: "THB"`.
- Env `PRIMARY_ACCOUNT=bidv` в `wrangler.toml` не трогать — лист Settings приоритетнее, редеплой не нужен.

### 2. A2 — Разовый снимок реальных балансов
- Собрать реальные числа: `trustwallet=1667`, `bybit=0`, `tbank_debit=<из свежего ZenMoney>`,
  `vtb_debit=<из свежего ZenMoney>`, `cash=<число пользователя>`. `maxswap=95.22` уже верен.
- Один `POST /api/snapshot` с массивом `balances:[{account,amount}...]` (SET, all-or-nothing).
- Проверить `GET /api/balances`: `updated_at` свежий, суммы совпали.

### 3. A1 — Крипто-поллер: trustwallet (Tron)
- Создать `scripts/crypto-poller.mjs` по структуре `zenmoney-poller.mjs` (env/state/api/retry/UA).
- trustwallet: GET `https://api.trongrid.io/v1/accounts/<TRUSTWALLET_ADDRESS_USDT_TRON>` (адрес из
  `.env`, ключ не нужен). Баланс USDT = TRC20 запись контракта `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`,
  raw `/1e6`. Округлить до 2.
- Флаги `--dry-run` (печать без записи) как в эталоне.

### 4. A1 — Крипто-поллер: bybit
- Переиспользовать HMAC-логику из `bybit-explore.mjs`: `/v5/account/wallet-balance?accountType=UNIFIED`.
- Баланс = walletBalance монеты USDT (если только USDT — можно totalEquity). Сейчас реально 0.
- Креды `BYBIT_API_KEY` / `BYBIT_API_KEY_SECRET` из `.env`.

### 5. A1 — Снимок + деплой
- Оба счёта → один `POST /api/snapshot { balances:[{account:'trustwallet',amount},{account:'bybit',amount}] }`.
  authority = прямой (баланс источника точный, без anchor/offset — offset только у дефектного дебет-коннектора ZenMoney).
- v1: только снимок баланса. Операции (TRC20-переводы, bybit deposit/withdraw, ститчинг MaxSwap↔bybit
  по on-chain хешу) — НЕ в этой итерации, отдельный шаг.
- Прогнать `--dry-run` на VPS, сверить числа, затем добавить cron на my-hetzner:
  `*/30 * * * * cd /opt/finance-app && /usr/bin/node scripts/crypto-poller.mjs >> scripts/.state/crypto-cron.log 2>&1`
- Синхронизировать файл на VPS (rsync/git pull в /opt/finance-app).

### 6. C2 — Закрыть вопрос по ZenMoney-поллеру (уже разобран)
- ФАКТ (чтение `zenmoney-poller.mjs`): снимок баланса делается на каждом прогоне (строки 235–259),
  но только для счетов, чей `balance` изменился в ZenMoney (diff по курсору). Молчащий банк ⇒ нет
  изменения ⇒ нет снимка. Это НЕ баг поллера — слабое звено — синк ZenMoney↔банк.
- Действие: проверить якоря дебета (`.state/zenmoney.json` offsets tbank_debit=0/vtb_debit=0) после
  сегодняшнего ручного ресинка — если коннектор снова врёт на константу, переставить `--set-anchor`.

### 7. C1 — Watchdog (свежесть, не живость)
- `scripts/watchdog.mjs`: раз в N часов (cron) читает `GET /api/balances` (`updated_at`) и/или поле
  `changed` счетов из `zenmoney-explore` логики. Если данные счёта старше порога (напр. 48ч) — пуш.
- Плюс сверка: снимок баланса против «старт + Σ операций из лога» (дрейф MaxSwap-сбора $0.25×N и т.п.).
- Канал пуша — Telegram-бот (сессия уже есть) или иной; выбрать при реализации.

### 8. B1 — Наличные траты (решение, не только код)
- Наличка в системе отсутствует. После A3 (primary=cash) быстрая трата с сайта пишется в THB-наличку —
  это и есть механизм ручного учёта. Зафиксировать как рабочий путь.
- Открытый вопрос: поддерживает ли ZenMoney тайские банки (для будущего QR/онлайн-банкинга) —
  проверить фактами, когда пользователь заведёт тайскую карту.

### 9. D1 — Импорт истории BIDV (низкий приоритет)
- `DRY_RUN=1 python3 scripts/import-bidv.py` — показать, что зальётся из выписки, без записи.
- После просмотра пользователем — при желании боевой прогон (идемпотентен по `client_id=bidv_<ref>`).

### 10. D2 — Обновить CLAUDE.md
- Убрать «pending» у log_only и hidden-блока (оба в проде). Отразить крипто-поллер и watchdog.

### 11. Финальная валидация
- Прогнать все Validation Commands ниже. Балансы в таблице = реальности; крипто-поллер пишет по cron.

## Testing Strategy
- Юнит: `cd api && node test-smoke.mjs` (чистая логика; крипто-поллер сам не меняет `src/index.js`,
  но снапшот-контракт не должен сломаться).
- Крипто-поллер: обязательный `--dry-run` перед боевым запуском — сверить числа с живыми источниками
  (`trustwallet` ≈ Trongrid, `bybit` ≈ explore) до записи в таблицу.
- Идемпотентность снапшота: повторный прогон поллера не должен ломать балансы (SET, не дельта).
- Edge cases: пустой ответ Trongrid (нет TRC20 записи → 0), bybit без USDT-монеты (→ 0),
  сетевой сбой (retry/backoff как в эталоне), неизвестный account в snapshot (400, all-or-nothing).

## Acceptance Criteria
- `GET /api/balances`: `primary="cash"`, `primary_currency="THB"`.
- `GET /api/balances`: `trustwallet≈1667`, `bybit=0`, наличка = число пользователя, `updated_at` свежий.
- `scripts/crypto-poller.mjs --dry-run` печатает корректные балансы trustwallet+bybit без записи.
- Крипто-поллер стоит в crontab на my-hetzner и пишет в `scripts/.state/crypto-cron.log`.
- `node test-smoke.mjs` — зелёный.
- CLAUDE.md не описывает уже сделанное как pending.

## Validation Commands
- `cd api && node test-smoke.mjs` — юнит-логика API зелёная.
- `node scripts/crypto-poller.mjs --dry-run` — превью балансов крипты без записи.
- `curl -s 'https://finance.daniilkravchenko.com/api/balances' -H "Authorization: Bearer $APP_TOKEN" -H 'User-Agent: Mozilla/5.0'`
  — проверить primary=cash, trustwallet/bybit, updated_at (токен из `api/.dev.vars`, не хардкодить).
- `ssh my-hetzner 'crontab -l | grep crypto'` — крипто-cron установлен.
- `ssh my-hetzner 'tail -5 /opt/finance-app/scripts/.state/crypto-cron.log'` — поллер пишет без ошибок.

## Notes
- Зависимости новых пакетов не нужны: Trongrid — публичный HTTP без ключа, bybit HMAC — на `node:crypto`
  (как в explore). Поллер dependency-free, в духе остальных скриптов (нет package.json/node_modules).
- Порядок приоритета пользователя: A3 → A2 → A1 → C1/C2 → D.
- Ключевой урок надёжности: цепочка не надёжнее слабейшего звена (синк ZenMoney↔банк стоял 2 недели
  молча). Отсюда watchdog по свежести данных — обязательный, не опциональный, компонент.
- Наличные траты на Пхукете за прошлый период (12 июня — сейчас) в системе не восстановимы —
  данных нет. A3 включает учёт только с этого момента вперёд.
