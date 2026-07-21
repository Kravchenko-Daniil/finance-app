# Changelog

История изменений по сессиям. Свежие записи сверху.

---

## 2026-07-21 — Балансы: Cash целым числом ✅ (задеплоено, `5f3a5f2`)

Баланс счёта `cash` показывается целым (`Math.round`) везде, где он виден: экран «Балансы»
(включая финальный кадр count-up) и карточки выбора счёта в форме событий. Хелпер `balAmt()`
в `web/index.html`. Только отображение: в Sheets значение хранится с прежней точностью,
копейки других счетов (USDT) не тронуты. Прод проверен (curl отдаёт новую версию).

## 2026-07-20 — Denis: авто-учёт обмена USDT→THB ✅ (на VPS; `fd9dd0c`+`8a3e1fb`+`0854c5f`)

Второй Telegram-источник агрегатора: диалог с менялой. `scripts/denis_parser.py` — парсер +
машина состояний (37 тестов), `maxswap_listener.py` отрефакторен под мультиисточник (регресса
нет: maxswap 49/0, smoke 163/0). Обмен пишется парой событий: income `cash` + expense `bybit`
(`log_only` — счёт зеркалится снимком поллера). Env-ключ переименован в нейтральный
`TELEGRAM_EXCHANGE_USERNAME`; добавлена лог-квитанция приёма (метаданные, без текста) для
полевой проверки направления (§4.2 постановки в `docs/private/`). Листенер живёт на VPS
(systemd), лог «слушаю: maxswap, denis». Осталось полевое: «тест» в диалог + реальный обмен.

## 2026-07-18 — Крипто: баланс bybit, чистка лога, watchdog v2 ✅

Три пункта постановки `docs/specs/crypto-reconciliation.md` (цепочка 1→2→3). Данные/бэкенд
крипто-слоя: правильный баланс bybit, лог без заплаток, добавлена сверка целостности.

### П.1 — bybit Earn виден (`scripts/crypto-poller.mjs`)
`fetchBybit` считал только UNIFIED-кошелёк и показывал `0`, хотя деньги лежали в Bybit Earn.
Теперь счёт `bybit` = сумма трёх сегментов USDT: `UNIFIED.walletBalance + FUND.transferBalance +
Σ Earn(FlexibleSaving).amount` (principal, без `claimableYield`). Добавлены `fetchBybitFunding`,
`fetchBybitEarn`; `bybitGet` получил режим `soft` — необязательный сегмент (нет прав / пусто /
`retCode!=0`) даёт вклад 0 и не роняет поллер. Приёмка `--dry-run`: `bybit(USDT)=112.01`
(UNIFIED=0 · FUND=0.01 · Earn=112).

### П.2 — чистка лога (через API, под бэкапом)
Удалено 9 крипто-строк `log_only:false` из `Events`: искусственные заплатки (baseline/correction)
и уже-задвоенные backfill'ом дубли переводов. Каждое реальное движение осталось в логе один раз
(16 движений + backfill-поток). После чистки — боевой снимок поллера выровнял балансы
(`trustwallet=0`, `bybit=112.01`). Правки только через API (правило 1), с предварительным бэкапом
листов (`scripts/_backups/`). Удаление — по явному согласию владельца.

### П.3 — watchdog v2, сверка целостности (`scripts/watchdog.mjs`)
Реализован `TODO(v2)`: сверка «снимок ?= старт + Σ `log_only`-операций» для зеркалимых снимком
счетов. Читает `GET /api/events` + `GET /api/balances`, сворачивает мутации `log_only:true`
событий (логика `applyMutation`: income/+, expense/−, transfer, exchange) от старта 0, сравнивает
со снимком, дельта > epsilon → тревога с разбивкой по счёту (канал как v1: stderr+exit).

## 2026-07-18 — Навбар: 3 иконки + меню-гамбургер (`7be9349`)

Навбар разгружен до трёх иконок (запись/балансы/день) + гамбургер — правый выезжающий лист
с «События», «Регулярные платежи», «Настройки». Новые stroke-иконки балансов/платежей/событий;
закрыта заметка «иконка recurring путается с refresh».

## 2026-07-18 — `Recurring` перестроен под payday-модель ✅ (задеплоено, `c1a0320`)

Экран регулярных платежей переведён с банковских дат + начисления долга на **payday-бакеты
Даниила (5/20)**. Старый экран отвечал про чужой график (даты банка) и показывал фантомный
долг `424 968 ₽` (артефакт `accrue`). Тело кредита на экране больше не ведём — оно уже живёт в
скрытых `Balances`-счетах (ZenMoney). Постановка: `docs/specs/recurring-payday-model.md`.

### Модель
- **Ось — payday 5/20**, не банк-дата. Колонки листа `Recurring` переименованы (ширина A:I та же):
  `E due_day→payday`, `F owed→paid_amount`, `H next_due→defer_to`; `G last_paid`, `I cycle` — как были.
- **Статус на чтении**, набор из пяти: `upcoming · due · paid · partial · overdue`. Окно упреждения
  `lead` (по умолчанию 3 дня) — в KV `CONFIG`, тем же путём, что `timezone`.
- **`accrue`/`owed` удалены целиком.** Начисления тела нет; частичная оплата (`paid_amount`) и перенос
  (`defer_to`) — новые механики. Суммы между месяцами не складываются (смена месяца обнуляет внесённое).

### Что сделано
- **`api/src/index.js`**: `RECURRING_COLS` на новую раскладку; `computeRecurringStatus` переписан под
  payday-формулу (`readLead` по образцу `readTimezone`, `getConfig`/`putConfig` расширены полем `lead`);
  `GET /api/recurring` отдаёт `payday/status/paid/remaining/due_date/days_until` + корневые `today/lead`
  (без `owed`/`owed_base`); `payRecurring` — частичная/полная оплата с `{item, prev}`; `payday 1..31` в
  `validateRecurring`, перенос через `PATCH {defer_to}`. `Balances` не трогается (правило 8).
- **`api/test-smoke.mjs`**: inline-копии заменены на payday-модель, кейсы под 5 статусов + частичную +
  смену цикла + `defer_to`. **163/0**.
- **`web/index.html`**: экран `recurring` — две группы по payday (ближняя развёрнута, дальняя свёрнута),
  секция «Просрочено» сверху, pay-sheet с полной/частичной оплатой и переносом на →5/→20, иконки статуса
  сведены к пяти. Навбар-иконка (круговая стрелка) **не менялась** — отдельным заходом.
- **`scripts/migrate-payday-model.mjs`** (новый, `DRY_RUN=1`): read+rewrite листа `Recurring` — payday по
  карте, обнуление `owed`, +строка VPS Hetzner ($10). **`scripts/backup-sheets.mjs`**: в бэкап добавлен
  лист `Recurring`.
- **Приёмка на живом проде** по 6 пунктам спеки пройдена (6 позиций, VPS есть, бакет 20 = `due`,
  частичная 40000→остаток 27523, перенос→`upcoming`, балансы не сдвинулись).

### Осталось (отдельными заходами)
- Иконка кнопки `recurring` (`docs/specs/navigation-and-recurring-ux.md`, п.1) — ждёт выбора формы.
- Навигация целиком (там же, п.2) — ждёт ответов Даниила на 5 вопросов.

## 2026-07-08 — Вся документация собрана в `docs/`

Реорганизация документов: единое место `docs/` вместо разбросанных `specs/` и gitignored `dev/{notes,work}`.

- **`docs/`** — публичное (в git): `CHANGELOG.md`, `deploy.md`, `specs/` (незакрытые планы), `archive/` (реализованные планы). Добавлен `docs/README.md` — карта «что в какой папке».
- **`docs/private/`** — gitignored (реальные балансы/долги): дизайн-заметки аггрегатора + `handoff.md` (живой снимок «где остановились») + `archive/` (старые `plan-state-*`). Свой `README.md`.
- Реализованные `recurring-payments-tracker` и `wire-v2-to-api` переехали в `docs/archive/`. Папки `dev/`, `specs/`, имена `work`/`notes` — удалены.
- `.gitignore`: `dev/` → `docs/private/`. Перекрёстные ссылки в живых доках обновлены; архивные снимки заморожены как есть.

## 2026-07-08 — Трекер регулярных кредитных платежей (лист `Recurring`) ✅ (задеплоено, `e603401`)

Отдельный экран-«напоминалка» под ежемесячные кредитные обязательства: что / сколько / до какого числа должен, что внёс, когда доплатит остаток. **Балансы не двигает** — чистый график обязательств (тело кредита ведёт ZenMoney на debt-счетах `Balances`); никаких мутаций `Balances`/`Events`.

### Модель (ядро)
- **Перенос долга (модель Б, подтверждена Даниилом):** долг растёт каждый месяц на `amount` **независимо от оплат**. Начисление **ленивое, на чтение** (`owed = owed_base + amount*monthsElapsed(cycle, curYM)`), персист — только на запись; самоисцеляется на пропущенных месяцах, без cron.
- **`CYCLE` обязателен как якорь** (`YYYY-MM`); пустой = safe-фолбэк без начисления. Скрипт сидинга ставит `CYCLE=месяц заведения`.
- Статусы `done/partial/partial-overdue/pending/overdue`, `next_date` определён во всех ветках, клэмп `due_day=31` по дням месяца.

### Что сделано
- **`api/src/index.js`**: pure-логика (`accrue`/`computeRecurringStatus`/`monthIndex`/`clampDay`/`addMonthYM`…), `readRecurring`/`writeRecurringRow`, роуты **`GET /api/recurring`** (список + вычисленный статус, лист не переписывается), **`POST /api/recurring/:id/pay`** (оплата/закрытие + `next_due`), **`PATCH /api/recurring/:id`** (правка/undo). В ответе раздвоены `owed_base` (сырой из листа) и `owed` (вычисленный); undo через `prev` (сырой `owed`+`cycle`, ключ `owed` — чтобы `PATCH` принял).
- **`api/test-smoke.mjs`**: inline-копии + кейсы a–m (перенос, partial-overdue, клэмп, Dec→Jan, двойная оплата, `next_date` во всех ветках). **150/0**.
- **`web/index.html`**: экран `recurring` (nav-иконка, карточки со статусами, bottom-sheet оплаты по образцу `renderSettings`, тост с undo — инфраструктура тоста обобщена под колбэк отмены по контексту). **`web/sw.js`**: `CACHE=finance-app-v26`.
- **`scripts/create-recurring-sheet.mjs`** (новый, re-runnable, `DRY_RUN=1`): создаёт лист `Recurring` (`addSheet`, читает новый `sheetId`), сеет кредиты, косметика (скрыты `id`/`CYCLE`). `numFmtCur`/`CURSYM`/`NODEC` вынесены в `scripts/_lib.mjs` как общий источник (из `format-sheets.mjs`).
- **`CLAUDE.md`**: лист `Recurring`, эндпойнты, модель начисления; плюс блок про Cloudflare-креды в корневом `.env` и деплой из неинтерактивной среды.

### Схема листа `Recurring` (4-й лист)
`A:id  B:NAME  C:AMOUNT  D:CURRENCY  E:DUE_DAY  F:OWED  G:LAST_PAID  H:NEXT_DUE  I:CYCLE` — скрыты `id` и `CYCLE`.

### Процесс (orchestrate → Workflow)
Собрано через Workflow: 4 билд-агента параллельно по непересекающимся файлам → детерминированная проверка + состязательный контроль контракта. Ревью поймало реальный баг **H1** (undo слал `prev.owed_base`, а `PATCH` принимает только `owed` → долг не восстанавливался) — починено (ключ `owed`) и перепроверено свежим агентом.

### Деплой
- Лист `Recurring` засеян **5 реальными кредитами** (ВТБ / Т-Банк кредит / Т-Банк кредитка / МТС / Альфа), `CYCLE=2026-07`. Реальные суммы — только в таблице, в git (публичный `quick-expenses`) не попали: `create-recurring-sheet.mjs` закоммичен с плейсхолдерами.
- API + Pages задеплоены (токен из `.env`). Smoke: `GET /api/recurring` → **HTTP 200**, статусы верны по активной зоне (ВТБ overdue, остальные pending, Альфа due сегодня).
- ⚠️ Этот `wrangler deploy` вынес в прод **текущий `api/src/index.js` целиком** — значит ранее не задеплоенные батчи **2026-06-16 / 2026-06-17** (log_only, snapshot, config/KV-timezone, CRUD-по-id, лист `Settings`) теперь тоже живые. Прод больше **не** на коде 2026-06-05.

---

## 2026-06-17 — `log_only`: события без движения баланса ⏳ (рабочее дерево, НЕ задеплоено)

Флаг `log_only:true` на `POST /api/event` / `PATCH /api/event/:id`: событие пишется в лог, но баланс **не двигает**. Нужен будущему аггрегатору — счёт, чей баланс зеркалится через `POST /api/snapshot`, нельзя ещё и мутировать операциями (двойной счёт), но операции хочется видеть в логе для аналитики/сторожа.

- `api/src/index.js`: `EVENT_COLS` + `log_only` (скрытая колонка `Events!K`); `rowToEvent`/`eventToRow` (true→boolean `TRUE`, false→пустая ячейка); диапазоны чтения/записи `A:J`→`A:K`; `createEvent` (log_only → только append, без мутации); **условный ребаланс** в `patchEventById` (`reverse(old)` если `!old.log_only`, `apply(new)` если `!new.log_only`; матрица 4 комбо); `deleteEventById`/`handleEventDelete` (log_only → без реверса).
- `api/test-smoke.mjs`: inline-копии в синхроне, **94/0** (+10 тестов).
- `scripts/migrate-schema-v3-logonly.mjs` (новый, re-runnable, `DRY_RUN=1`): пишет `K1='log_only'`, скрывает колонку K. **Против живого листа не запускался.**
- **Статус:** в рабочем дереве, не закоммичено, не задеплоено. Известный gap: код **не** enforce'ит, что зеркалимый счёт получает только `log_only`-операции — пока на дисциплине поллера.

---

## 2026-06-16 — Авто-балансы, конфиг-эндпойнты, CRUD-по-id, реструктуризация ⏳ (закоммичено `8d82bb6`/`2dd0953`, НЕ задеплоено)

Большой батч API-фич под будущий аггрегатор + наведение порядка. **Прод всё ещё на коде 2026-06-05** — этот батч ждёт общего деплоя (ШАГ 0).

### API (`api/src/index.js`)
- **`POST /api/snapshot`** — пишет балансы счетов снимком (SET, не дельта; «сигнал 1» аггрегатора). Зеркалит перечисленные счета из источника, **лог не трогает**, all-or-nothing валидация. Чистая логика `applySnapshot`.
- **`GET` / `PUT /api/config`** — timezone вынесен в **Cloudflare KV** (биндинг `CONFIG`, ключ `timezone`), меняется с сайта без редеплоя. Функции времени параметризованы зоной (`readTimezone`/`zoneContext`/`dateInZone`/`formatWhen`).
- **`PATCH /api/event/:id`** / **`DELETE /api/event/:id`** — правка/удаление **любого** события по id (условный пересчёт балансов), не только последнего.
- **`GET /api/events`** — весь лог (опц. `?type=`/`?limit=`) для reconciliation из Claude Code.
- **Лист `Settings`** (третий лист) — `primary_account`/`primary_currency` читаются из таблицы (`readSettings`); env `PRIMARY_ACCOUNT`/`PRIMARY_CURRENCY` — фолбэк.
- Дедуп `client_id` расширен с «последних 200 строк» до **всего лога** (стабильный source-id для backfill аггрегатора).
- Парсер: добавлены валютные токены `thb | бат | baht | vnd | донг` к `usdt | rub | руб`.

### Структура (`8d82bb6`, `2dd0953`)
- Создана gitignored `dev/` (`raw`/`notes`/`work`) под закулисье (реальные балансы, дизайн аггрегатора). Удалены `sync/`/`hooks/` эпохи GitHub-стораджа. Из текста доков убраны «pwa»/«worker» → «web app»/«API».

---

## 2026-06-05 — Схема таблицы v2: человекочитаемый вид ✅ (задеплоено, `9b2760f`)

Переезд схемы под человеческий вид. Заголовки английские БОЛЬШИЕ; единственная русская колонка — `Note`.
- **Счета**: `card_t`→`tbank_debit`, `card_vtb`→`vtb_debit`; `DEFAULT_ACCOUNT_RUB`→`tbank_debit`.
- **Events**: колонки `When | Type | From | To | Amount | Received | Note` (+ скрытые `id`/`at`/`client_id`). `When` — деривированная display-дата (`formatWhen`): только дата для backdate-плейсхолдера (полдень), иначе дата+время.
- **Balances**: строка `Updated` сверху, таблица счетов ищется **сканом заголовка `id`** (колонка id скрыта), блок `Totals` (SUMIF на валюту) ниже. `readBalances` отдаёт `dataStartRow` писателю.
- Операторские скрипты (общий `scripts/_lib.mjs`): `backup`, `migrate-schema-v2`, `verify`, переписанный `format`. Тесты 63/63.

---

## 2026-06-05 — Миграция стораджа на Google Sheets

Единое онлайн-хранилище вместо приватного GitHub-репо. Теперь данные — Google-таблица с двумя листами (`Events` + `Balances`), которую можно смотреть и править напрямую с любого устройства.

### API (`api/src/index.js`) — полностью переписан storage-слой
- GitHub Contents/Trees API → **Google Sheets API**. Аутентификация: JWT сервис-аккаунта (RS256 через WebCrypto) → OAuth access token, кэш токена в isolate (`getAccessToken`).
- `GET /api/balances` — читает лист `Balances`. `GET /api/day` — фильтрует expense-события из листа `Events` (markdown больше не читается). `POST /api/expense|event` — append в `Events` + мутация колонки amount в `Balances`. `DELETE /api/event/last` — реверс баланса + `deleteDimension` последней строки `Events`.
- Контракт ответов для сайта сохранён байт-в-байт (`{updated_at, accounts}`, `{event, balances}`, `{expenses, totals}`).
- Нет кросс-табличной атомарности (у Sheets нет транзакции между листами) — append/mutate последовательны; для одного пользователя окно гонки ничтожно, дрейф восстановим из лога. Идемпотентность по `client_id` сохранена (поиск в последних 200 строках `Events`).

### Конфиг
- `wrangler.toml`: убраны `REPO`/`BRANCH`/`GITHUB_TOKEN`; добавлены `SPREADSHEET_ID` (var) и `GOOGLE_SA_JSON` (secret).
- Ключ сервис-аккаунта — `api/google-service-account.json` (gitignored).

### Миграция
- `scripts/migrate-to-sheets.mjs` — одноразовый импорт `balances.json` + `events.json` + markdown-архива в таблицу. Dependency-free Node, JWT через `node:crypto`, `DRY_RUN=1` для превью. Прогон: 77 событий из лога + 104 из markdown (8 дублей по дням отброшены) = 181 событие, 5 счетов.

### Тесты
- `api/test-smoke.mjs` переписан: убраны markdown-тесты (`insertExpense`/`parseDay`), добавлены `bangkokDateOf` и round-trip `rowToEvent`↔`eventToRow`. 60/60 зелёные.

### Retired
- Приватный data-репо `my-finance`, WSL cron (`sync/pull.sh`) и SessionStart hook заморожены как бэкап — в рантайме Sheets-трекера не участвуют.

---

## 2026-05-03 — UX-полировка сайта (SW v6)

### Поле токена в настройках — скрыто точками
- `web/index.html:164` — `input#token` с `type="text"` → `type="password"`. Браузер маскирует значение, стиль уже покрывает `input[type="password"]` (строка 38).

### Очередь больше не зависает на 4xx, и её можно очистить вручную
- `web/app.js` — `tryPost` теперь возвращает `status` HTTP-ответа.
- `web/app.js` — в `flush()` добавлен ветка: при ответе `4xx` item выкидывается из очереди (4xx — это про сам item, ретраить бесполезно — иначе очередь блокируется навсегда). По итогам `flush` показывается отдельный статус `⚠ выброшено из очереди (ошибки): N`.
- `web/app.js` — у `#queue-info` появился click-handler: тап → `confirm("Очистить очередь (N)?")` → `setQueue([])`. Текст изменён на `В очереди: N (нажми чтобы очистить)`, курсор `pointer` когда есть что чистить.
- **Почему:** записал `test 0` офлайном — попало в очередь, парсер API вернул `400 error value`, и любой следующий flush ронялся на этом же item. Теперь самоисцеляется + есть аварийный выход.

### Tiffany Blue для primary-кнопок
- `web/index.html` — `#4a90e2` → `#0abab5` в трёх местах: `button` (фон), `input:focus` (border), `#panel button.action` (фон). Текст на кнопках стал `#0a0a0a` (тёмный) для контраста на бирюзе вместо белого.

### Service Worker
- `web/sw.js:1` — `CACHE` поднят `v4` → `v5` → `v6`, чтобы старые HTML/JS из кэша инвалидировались на устройствах.

### Деплой
- Финальный URL после трёх деплоев: `https://014b6d7f.my-finance-pwa.pages.dev` (alias `my-finance-pwa.pages.dev` указывает на актуальный production).
- API не трогали — изменений в `api/` нет.
