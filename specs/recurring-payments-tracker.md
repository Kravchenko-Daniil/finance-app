# Plan: Экран-трекер регулярных кредитных платежей

## Task Description
Добавить в finance-app отдельный экран-«напоминалку» для регулярных ежемесячных
платежей по кредитам. Даниил держит в голове: какие кредиты, сколько платить,
до какого числа, что уже внёс в этом месяце и когда доплатит остаток. Цель —
выгрузить это из головы на сайт.

Ключевые свойства (из обсуждения с Даниилом):
- **Деньги НЕ двигаются.** Балансы кредитов уже ведёт ZenMoney-поллер (debt-счета
  на листе `Balances`, заведены миграцией v4). Этот трекер — чистый график
  обязательств: «что / сколько / когда должен и когда внесёшь». Никакой мутации
  `Balances`, никаких событий в `Events`.
- **Долг переносится (вариант Б).** Каждый месяц к долгу кредита добавляется
  месячная норма (`amount`). Недоплаченный остаток прошлого месяца суммируется с
  новой нормой — виден общий долг. Это ровно «в июне недоплатил 7 000 → в июле они
  добавляются к июльской сумме».
- **Частичная оплата.** Пользователь вносит часть суммы и **ставит дату следующего
  взноса** (намерение на будущее, задаётся вручную — не системная дата).
- **Смена месяца — чистое вычисление** по активной timezone (из KV), без cron.
- **due_day = 31 в коротком месяце** → клэмп к последнему дню месяца.

Скоуп MVP:
- Внесение оплат и постановка даты доплаты — с сайта (главное действие).
- Сам список кредитов на старте заполняется руками в таблице (Даниил пришлёт
  название / месячную сумму / до какого числа). Добавление/редактирование кредита
  прямо с сайта — вне MVP.

## Objective
Работающий экран `recurring` в нижней навигации `web/index.html`, читающий и
пишущий новый лист `Recurring` в той же таблице через новые эндпойнты API. По
каждому кредиту видно: месячная сумма, текущий долг, статус (закрыто / частично /
ждёт / просрочено) и дата следующего платежа. Одним тапом — «оплатил полностью»,
либо «внёс часть» с суммой и датой доплаты.

## Problem Statement
Сейчас у Даниила нет ни одного места, где фиксируются регулярные кредитные
обязательства. Факт списания виден в ZenMoney (движение по ВТБ/ТБ), но «какой
платёж, сколько, до какого числа, закрыт ли в этом месяце, сколько осталось
доплатить» нигде не отображается — это когнитивная нагрузка, которую он хочет
снять. MVP-контракт «≤5–10 сек на захват» не нарушается: экран отдельный, главный
экран записи траты не трогается.

## Solution Approach
Повторяем сложившийся паттерн проекта «лист в таблице ↔ эндпойнт API ↔ экран
фронта», один-в-один как `Balances`/`Settings`:

1. **Новый лист `Recurring`** — источник данных. Схема в стиле v2 (английские ВСЕ
   БОЛЬШИЕ заголовки, скрытые машинные колонки). Список кредитов правится руками;
   машинное состояние (накопленный долг, курсор месяца) пишет API.
2. **Чистая доменная логика долга/статуса** — pure-функции без fetch/Sheets
   (`accrue`, `computeRecurringStatus`), покрыты юнит-тестами в стиле
   `api/test-smoke.mjs`. Здесь живёт весь расчёт переноса долга, статусов и
   следующей даты — единая точка правды, тестируемая без сети.
3. **Эндпойнты API** — `GET /api/recurring` (список + вычисленный статус),
   `POST /api/recurring/:id/pay` (внести оплату / закрыть полностью + дата
   доплаты), `PATCH /api/recurring/:id` (правка/undo). Auth уже глобальный
   (`APP_TOKEN`).
4. **Экран фронта** — регистрируется в реестрах `BODY`/`WIRE`, иконка в nav,
   действие оплаты через bottom-sheet по образцу `renderSettings`. Тост с undo —
   как у событий.

### Модель накопления долга (ядро)
Каждый кредит хранит машинное состояние:
- `owed_base` — непогашенный долг, начисленный **по месяц `cycle` включительно**.
- `cycle` — маркер `YYYY-MM`, до которого норма уже начислена в `owed_base`.

Начисление **ленивое, считается на чтение** относительно `cycle` (GET —
без сайд-эффектов, ничего не персистит):

```
owed(сейчас) = owed_base + amount * monthsElapsed(cycle, текущий_месяц)
```

Любая **запись** (оплата) сначала «докатывает» долг до текущего месяца
(`owed_base += amount * k; cycle = текущий_месяц`), затем вычитает внесённую сумму
и персистит строку. Так GET остаётся чистым, а writes — авторитетными.
Самоисцеляется: пропущенный месяц довзыщется на следующем чтении, никакой cron не
нужен.

**Сидинг руками добавленного кредита (модель Б: долг растёт всегда).** Долг должен
накапливаться каждый месяц **независимо от того, вносил ли пользователь оплату** —
даже по кредиту, который ни разу не трогали. Чтобы это работало и при этом GET
оставался чисто читающим (не пишет в лист на каждое открытие), у каждого кредита
**`CYCLE` обязан быть заполнен** — это якорь начисления: месяц `YYYY-MM`, на который
актуальна цифра в `OWED` (месячная норма этого месяца уже включена в `OWED`).
Начисление тогда считается по календарю от `CYCLE` до текущего месяца **на чтении**,
без записи: `owed = owed_base + amount * monthsElapsed(cycle, текущий_месяц)` растёт
сам, платил пользователь или нет.

При заведении кредита Даниил вписывает `OWED` = текущий причитающийся долг (например
15000) **и** `CYCLE` = текущий месяц (`2026-07`). Скрипт-сидинг
(`create-recurring-sheet.mjs`) заполняет `CYCLE = месяц заведения` автоматически —
пустым его **не оставляет** (иначе долг замёрзнет на стартовой цифре: пустой `cycle`
трактуется как «текущий месяц» на КАЖДОМ чтении, `accrued = 0`, начисление никогда не
стартует). Пустой `CYCLE` остаётся деградированным safe-фолбэком (не начисляет, но и
не портит данные) на случай ручной ошибки — нормальный режим всегда с заполненным
`CYCLE`. В `CLAUDE.md` и в шапке скрипта — явная пометка: **добавляя кредит руками,
заполни `CYCLE` месяцем.**

### Статусы (pure `computeRecurringStatus(rec, todayYMD)`)
`owed` = ленивое начисление до месяца `todayYMD`. `dueDate` = `YYYY-MM-clamp(due_day)`
текущего месяца. `paidThisCycle` = месяц `last_paid` равен текущему.
- `owed <= 0` → **done (✓)**. `next_date` = due_day следующего месяца.
- иначе если `paidThisCycle` **и** (нет `next_due`, либо `next_due >= todayYMD`) →
  **partial (◐)**. `next_date = next_due || due_day след. месяца`. Показать «осталось
  {owed} · внесёшь {next_date}».
- иначе если `paidThisCycle` **и** `next_due < todayYMD` → **partial-overdue (◐⚠)** —
  доплата, которую пользователь обещал и пропустил. `next_date = next_due`. «осталось
  {owed} · доплата просрочена с {next_due}». (Без этой ветки просроченный `next_due`
  завис бы в обычном partial — M2.)
- иначе если `todayYMD <= dueDate` → **pending (○)**. `next_date = dueDate`. «до
  {dueDate}, через N дней».
- иначе → **overdue (⚠)**. `next_date = next_due || dueDate`. «просрочено с {dueDate}».

**`next_date` определён во ВСЕХ ветках** (иначе `days_until` = NaN на фронте — LOW).
`days_until = разница(todayYMD, next_date)` в днях (UTC-парс дат): для pending
положительный, для overdue отрицательный/ноль. Покрыть знак тестом в каждой ветке.

## Relevant Files
Use these files to complete the task:

- `api/src/index.js` — добавить роуты в `fetch()`, ридер листа `readRecurring`,
  райтер `writeRecurringRow`, pure-логику (`monthIndex`/`monthsElapsed`/`clampDay`/
  `accrue`/`computeRecurringStatus`), хендлеры `getRecurring`/`payRecurring`/
  `patchRecurring`. Следовать существующим паттернам: скан колонки A на заголовок
  (как `readBalances`), `sheetsValuesGet` c UNFORMATTED_VALUE, запись RAW, округление
  `Math.round(x*100)/100`, ответы `json()/ok()/error()`.
- `api/test-smoke.mjs` — inline-копии новых pure-функций + тест-кейсы (держать в
  синхроне с `src/index.js`, как уже сделано для parseExpense/formatWhen/mutation).
- `web/index.html` — новый экран: `navBtn('recurring', …)` в `mount()`, добавить
  `'recurring'` в оба forEach (`mount` bind + `updateNav`), `wrapStyle.recurring`,
  `BODY.recurring`/`WIRE.recurring`, ветку в `setActiveScreen` → `loadRecurring()`,
  `loadRecurring()`, bottom-sheet оплаты (по образцу `renderSettings`), поля состояния
  (`recurring`, `recurringLoaded`, `paySheet`). Иконка в `ICONS`.
- `web/config.js` — переиспользовать `AppConfig.today()` / `AppConfig.dateOf()` /
  `AppConfig.tz()`. Отдельный фронтовый хелпер дат, судя по `BODY.recurring` (использует
  только `disp`/`curSymbol`), **не нужен** — вся календарная логика на бэке (Шаг 3).
  Правок в API-контракта не требует.
- `web/sw.js` — бампнуть `CACHE` (`finance-app-v25` → `v26`), чтобы клиенты
  подтянули новый `index.html`.
- `scripts/_lib.mjs` — готовые `getToken/valuesGet/valuesUpdate/batchUpdate/getMeta`
  для one-off скрипта создания листа (addSheet + заголовки + формат).
- `scripts/format-sheets.mjs` — эталон косметики (hidden-колонки, ширины, числовые
  форматы, freeze, conditional formatting). Опционально расширить блоком для
  `Recurring`, чтобы косметика была re-runnable.
- `CLAUDE.md` — задокументировать новый лист `Recurring` (схема колонок) и новые
  эндпойнты в разделах «Архитектура» и «Что нужно знать перед правками».

### New Files
- `scripts/create-recurring-sheet.mjs` — одноразовый (re-runnable) скрипт: создаёт
  лист `Recurring` (`addSheet`, если ещё нет — читая новый `sheetId` из ответа, см.
  Шаг 2), пишет строку заголовков, засевает кредиты Даниила из конфиг-массива (`CYCLE`
  = месяц засева, НЕ пусто), применяет косметику (скрыть `id`/`CYCLE`, ширины, числовые
  форматы, freeze). Поддержать `DRY_RUN=1`. Стиль (dependency-free, `_lib.mjs`) — как
  `migrate-schema-v4-debts.mjs`, но `addSheet`/чтение `sheetId` — новьё для репо (v4
  листов не создаёт).

## Implementation Phases
### Phase 1: Foundation — данные и лист
Создать лист `Recurring`, определить схему колонок, засеять кредиты (плейсхолдеры,
пока Даниил не пришлёт реальные суммы/даты). Написать и протестировать pure-логику
долга/статуса.

### Phase 2: Core Implementation — API
Ридер/райтер листа, роуты, хендлеры `GET`/`POST pay`/`PATCH`. Прогнать юнит-тесты и
локальный `wrangler dev`, задеплоить, проверить curl'ом.

### Phase 3: Integration & Polish — фронт
Экран, nav-иконка, bottom-sheet оплаты, тост с undo, загрузчик, оффлайн-терпимость
(экран требует live-соединения, как balances/events — без offline-очереди). Бамп SW,
деплой Pages, обновить `CLAUDE.md`.

## Step by Step Tasks
IMPORTANT: Execute every step in order, top to bottom.

### 1. Зафиксировать схему листа `Recurring`
- Заголовки (строка 1, английские ВСЕ БОЛЬШИЕ, стиль v2):
  `A:id  B:NAME  C:AMOUNT  D:CURRENCY  E:DUE_DAY  F:OWED  G:LAST_PAID  H:NEXT_DUE  I:CYCLE`
- Скрытые колонки: `A (id)` — машинный ключ (`rec_tbank_cc` и т.п., на него ссылаются
  API-записи) и `I (CYCLE)` — маркер `YYYY-MM` начисления. Видимые для ручного
  редактирования/просмотра: `B..H`.
- Семантика: `C:AMOUNT` месячная норма, `E:DUE_DAY` день месяца 1–31, `F:OWED`
  = `owed_base` (управляется API; при ручном заведении кредита Даниил вписывает
  текущий долг), `G:LAST_PAID` дата последней оплаты `YYYY-MM-DD`, `H:NEXT_DUE`
  заданная пользователем дата следующего взноса `YYYY-MM-DD`.
- Числа читаются/пишутся RAW/UNFORMATTED_VALUE. Даты хранятся текстом `YYYY-MM-DD`
  (как `at` — сырой строкой; не полагаемся на локальный парсинг Sheets).

### 2. Создать one-off `scripts/create-recurring-sheet.mjs`
- В шапке — массив `CREDITS` (id, name, amount, currency, due_day, owed). Пока
  плейсхолдеры (ТБ кредитка / ВТБ кредит / МТС кредит / Альфа кредитка) — заменить
  реальными значениями, когда Даниил пришлёт.
- Через `getMeta` проверить, есть ли лист `Recurring`; если нет — `batchUpdate` с
  `addSheet` (`properties.title = 'Recurring'`). ⚠️ **`addSheet` в этом репо не
  обкатан** — `grep addSheet scripts/*.mjs` пуст, все прежние миграции (v2/v3/v4)
  правят УЖЕ существующие листы и `die()`, если листа нет. Это стандартный Sheets API,
  но новая для репо операция, а не повтор паттерна v4. **Прочитать новый `sheetId` из
  ответа** (`replies[0].addSheet.properties.sheetId`) — он нужен косметическим запросам
  (hidden-колонки/freeze адресуются по `sheetId`, не по имени).
- Записать заголовки и строки кредитов (`valuesUpdate` `Recurring!A1:I{n}`). **`CYCLE`
  засеять текущим месяцем `YYYY-MM`, НЕ оставлять пустым** — иначе долг замёрзнет
  (модель Б требует заполненного якоря, см. «Сидинг»). `OWED` = текущий долг с уже
  включённой нормой месяца засева.
- Косметика через `batchUpdate`: `freeze` строки 1, header-стиль, hidden `A` и `I`,
  ширины, числовой формат для `AMOUNT`/`OWED` (по валюте). **`numFmtCur` из
  `format-sheets.mjs` НЕ экспортируется** (в файле нет ни одного `export`) — либо
  продублировать функцию/таблицу валют локально в скрипте (риск дрейфа — пометить),
  либо вынести `numFmtCur/CURSYM/NODEC` в `_lib.mjs` как общий источник (предпочтительно).
- `DRY_RUN=1` печатает план и выходит до записи.
- Реальная страховка операции — **идемпотентность самого скрипта** (re-runnable:
  delete-and-recreate листа `Recurring` дёшев), а не `backup-sheets.mjs`: тот бэкапит
  только `['Events','Balances']` (`:11`), новый лист не покрывает, а Events/Balances
  скрипт и не трогает. Прогнать `backup-sheets.mjs` перед запуском не вредно, но
  защищает не ту операцию — не выдавать это за v4-церемонию.

### 3. Добавить pure-логику в `api/src/index.js`
- Константа `const RECURRING_SHEET = 'Recurring';` и порядок колонок
  `const RECURRING_COLS = ['id','name','amount','currency','due_day','owed','last_paid','next_due','cycle'];`
- Хелперы дат месяца:
  ```js
  const monthIndex = (ym) => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
  const monthsElapsed = (fromYM, toYM) => Math.max(0, monthIndex(toYM) - monthIndex(fromYM));
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();      // m: 1-based
  const clampDay = (y, m, d) => Math.min(d, daysInMonth(y, m));
  const addMonthYM = (ym, k) => { const idx = monthIndex(ym) + k; return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`; };
  ```
- `accrue(rec, curYM)` → `{ owed, cycle: curYM, accrued }`: пустой `rec.cycle` →
  `cycle = curYM`, `accrued = 0`, `owed = rec.owed || 0`; иначе `k = monthsElapsed`,
  `owed = round2(rec.owed + rec.amount * k)`.
- `computeRecurringStatus(rec, todayYMD)` → `{ owed, status, next_date, due_date, days_until }`
  по правилам из «Статусы» выше. **`next_date` задан во всех ветках** (см. «Статусы»).
  Для «due_day следующего месяца» — **клэмпить по дням СЛЕДУЮЩЕГО месяца, не текущего**
  (M3): распарсить `addMonthYM(curYM,1)` → `(ny, nm)`, затем
  `${addMonthYM(curYM,1)}-${pad(clampDay(ny, nm, rec.due_day))}`. Иначе `due_day=31,
  curYM=2026-01` даст несуществующую `2026-02-31`. `days_until` = разница в днях между
  `todayYMD` и `next_date` (UTC-даты, как `addDays` на фронте).
- Округление денег `round2 = (x) => Math.round(x * 100) / 100` (переиспользовать
  подход `roundCents`).

### 4. Ридер/райтер листа в `api/src/index.js`
- `readRecurring(env, token)`: `sheetsValuesGet(env, 'Recurring!A1:I', token)`, парс
  строк до первой пустой. **Правильный образец — `readEvents` (`index.js:869-871`,
  фиксированный диапазон, заголовок всегда в строке 1), НЕ `readBalances`**: последний
  сканирует колонку A только из-за плавающего заголовка (блок «Updated» сверху,
  `:814-825`), а у `Recurring` заголовок жёстко в строке 1 (Шаг 1) — скан не нужен.
  Если всё же оставить защитный скан — обосновать (напр. «на случай ручной вставки
  строки над заголовком»), а не копировать обоснование чужой раскладки.
  Вернуть `{ items, dataStartRow }`, где каждый item:
  `{ id, name, amount:Number, currency, due_day:Number, owed:Number, last_paid, next_due, cycle, _row }`
  (`_row` = 1-based номер строки для точечной записи).
- `writeRecurringRow(env, rowNumber, rec, token)`: PUT `Recurring!A{n}:I{n}`, RAW,
  значения по `RECURRING_COLS` (`null`/пусто → `''`). По образцу `writeEventRow`.

### 5. Хендлеры и роуты в `api/src/index.js`
- В `fetch()` добавить (до 404):
  ```js
  if (req.method === 'GET' && url.pathname === '/api/recurring') return await getRecurring(env);
  const recMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)(\/pay)?$/);
  if (recMatch) {
    const id = decodeURIComponent(recMatch[1]);
    if (recMatch[2] && req.method === 'POST') return await payRecurring(req, env, id);
    if (!recMatch[2] && req.method === 'PATCH') return await patchRecurring(req, env, id);
  }
  ```
- **Хелпер `withStatus(rec, todayYMD)`** (определить в Шаге 3, использовать и в
  `getRecurring`, и в `payRecurring`): `({ ...rec, ...computeRecurringStatus(rec, todayYMD) })`.
  ⚠️ **Раздвоить ключи долга в ответе (критично для undo, см. H1):** `owed_base` — СЫРОЙ
  накопленный долг из листа (колонка F), `owed` — ВЫЧИСЛЕННЫЙ на чтении
  (`owed_base + amount*k`). Это два РАЗНЫХ числа, они не должны ехать под одним ключом.
  Ответ каждого item содержит оба: `owed_base` (для точного undo/правки) и `owed` (для
  показа). Так же — `cycle` (сырой якорь) отдаётся в ответе.
- `getRecurring(env)`: `token`+`tz`, `readRecurring`, `todayYMD = dateInZone(now, tz)`
  (использовать существующий `dateInZone` с текущим instant — либо
  `zoneContext(null, tz)` → собрать `YYYY-MM-DD`). Для каждого item — `withStatus`,
  вернуть `json({ items, timezone: tz })`. Долг/статус вычисляются виртуально,
  **лист не переписывается**.
- `payRecurring(req, env, id)`: тело `{ amount?:number, full?:boolean, next_due?:'YYYY-MM-DD', at?:ISO }`.
  Валидация: `full===true` XOR положительный `amount`; `next_due` — валидный
  `YYYY-MM-DD` или отсутствует. Прочитать лист, найти item по id (404 если нет).
  `curYM` из активной зоны. `acc = accrue(item, curYM)`. `pay = full ? acc.owed : amount`.
  `newOwed = round2(acc.owed - pay)`. **Перед записью снять pre-state** для undo:
  `prev = { owed: item.owed, cycle: item.cycle, last_paid: item.last_paid, next_due: item.next_due }`
  (сырые значения из листа ДО докатки). Собрать обновлённый rec:
  `owed=newOwed, cycle=curYM, last_paid = at ? dateInZone(at,tz) : todayYMD,
  next_due = newOwed > 0 ? (body.next_due || null) : null`. `writeRecurringRow`.
  Вернуть `ok({ item: withStatus(updated), prev })` — фронт кладёт `prev` в состояние
  и при отмене шлёт его в `PATCH` как есть.
- `patchRecurring(req, env, id)`: merge разрешённых полей
  (`name/amount/currency/due_day/owed/last_paid/next_due/cycle`) поверх сохранённого,
  revalidate, `writeRecurringRow`. `id` неизменяем. Правит колонки листа НАПРЯМУЮ
  (`owed` здесь = сырой `owed_base`, не вычисленный), поэтому:
  - **Undo (H1) шлёт СЫРЫЕ `owed_base` И `cycle`** из снимка ответа (не вычисленный
    `owed`!), плюс прежние `last_paid`/`next_due`. Иначе на стыке месяца `cycle`
    застрянет / долг задвоится. **Предпочтительный вариант — undo серверно:**
    `payRecurring` перед записью кладёт pre-state (`owed_base`,`cycle`,`last_paid`,`next_due`)
    в ответ (`prev`), фронт при отмене шлёт его обратно как есть — так клиент не собирает
    состояние из смешанного снимка. Выбрать этот путь при реализации.
- Валидация чисел/дат — в стиле `validateEvent` (понятные `error(400, …)`).

### 6. Экран `recurring` во фронте (`web/index.html`)
- `ICONS.recurring` — добавить глиф (например «повтор по кругу» или «карта»),
  отличный от `events`.
- В `mount()` HTML добавить `${navBtn('recurring', 'recurring')}` в блок nav.
- **Добавить в `mount()` HTML `<div id="paysheet-host"></div>`** (рядом с
  `toast-host`/`settings-host`, `web/index.html:129-130`) — иначе `renderPaySheet`
  некуда монтировать: `renderSettings` рендерит в заранее созданный `#settings-host`,
  своего host у pay-sheet нет (M4).
- В `mount()` и `updateNav()` добавить `'recurring'` в массивы экранов.
- ``wrapStyle.recurring = `animation:screenIn .34s ${EASE_OUT};display:flex;flex-direction:column;gap:1.25rem;` `` —
  **backtick-шаблонный литерал**, как соседние ключи (`web/index.html:164-169`); с
  одинарными кавычками `${EASE_OUT}` останется текстом и сломает анимацию (LOW).
- В `setActiveScreen`: `else if (name === 'recurring') loadRecurring();` — грузим
  всегда (данные динамические); без мёртвого `if(!recurringLoaded)…else` с одинаковыми
  ветками (LOW).
- Состояние: `recurring: [], recurringLoaded: false, paySheet: null` в `state`.
- `BODY.recurring`: заголовок «Платежи» + список карточек. Карточка: значок
  статуса (✓/◐/○/⚠ цветом — done `#5fd37e`, partial ACC, pending `#f0f0f0`/0.7,
  overdue `#e87171`), название, сумма/долг (`disp(owed, curSymbol)`), подпись
  следующей даты («дальше 5 авг» / «осталось 7 000 · внесёшь 20 июля» / «до 15 июля ·
  через N дней» / «просрочено с 3 июля»). `data-id` на карточке для тапа. Пустой
  список → «загрузка…»/«нет платежей».
- `WIRE.recurring`: тап по карточке (`data-id`) → `openPaySheet(id)`.
- `loadRecurring()`: как `loadBalances` — `if (!token) openSettings()`, `GET /api/recurring`,
  `AppConfig.cacheFrom(data)`, `state.recurring = data.items`, `recurringLoaded=true`,
  если экран активен — `renderBody()`. Тёплый кэш (localStorage `cache:recurring`)
  по желанию, по образцу балансов.

### 7. Bottom-sheet оплаты (`web/index.html`)
- `renderPaySheet(item)` по образцу `renderSettings` (overlay + modalIn):
  поля — сумма взноса (`inputmode="decimal"`), кнопка **«Оплатил полностью»**
  (подставляет весь `owed`), поле даты следующего взноса (`type="date"`, показывать
  при частичной сумме), кнопка **«Внести»**.
- Submit: собрать `{ amount }` или `{ full:true }`; если остаётся долг и задана дата
  — `next_due`. `POST /api/recurring/:id/pay`. Успех → обновить `state.recurring`
  (перезагрузить `loadRecurring()` или заменить item из ответа), закрыть sheet,
  `showToast(summary, { undoable:true })`, сохранить прежнее состояние item для undo.
- **Сначала обобщить инфраструктуру тоста (H2).** `renderToast()`
  (`web/index.html:471-473`) сейчас хардкодит `undoLast()` в обработчик клика, а
  `showToast` (`:451-457`) знает только `opts.undoable:boolean` — привязать
  `undoRecurring` «по образцу» физически некуда. Отдельным пунктом: провести через тост
  колбэк отмены (напр. `state.undoAction: 'event' | 'recurring'`, либо передаваемая в
  `showToast` функция), чтобы кнопка «Отменить» звала нужный undo по контексту. Внести
  правку `showToast`/`renderToast` в Relevant Files (`web/index.html`).
- `undoRecurring()`: `PATCH /api/recurring/:id` с сырым `prev` из ответа `pay`
  (`owed_base→owed`, `cycle`, `last_paid`, `next_due` — см. H1, НЕ вычисленный `owed`),
  затем `loadRecurring()`. Привязать через обобщённый колбэк тоста (выше), не через
  хардкод `undoLast`.

### 8. Бамп Service Worker
- `web/sw.js`: `const CACHE = 'finance-app-v26';`.

### 9. Юнит-тесты pure-логики (`api/test-smoke.mjs`)
- Inline-копии `monthIndex/monthsElapsed/daysInMonth/clampDay/addMonthYM/accrue/
  computeRecurringStatus`.
- Кейсы: (a) полностью оплачено в этом месяце → done, next = due след. месяца;
  (b) частично + перенос: `owed_base=7000, cycle=прошлый, amount=15000` →
  `owed=22000`, partial/overdue корректно; (c) не платил, `today <= dueDate` →
  pending с положительным `days_until`; (d) `today > dueDate`, не платил → overdue,
  `days_until <= 0`; (e) клэмп `due_day=31` в феврале → 28/29; (f) переплата
  (`owed<=0`) → done; (g) сидинг: пустой `cycle` → без начисления, `owed = OWED`
  (safe-фолбэк).
- **Новые кейсы под ревью-правки:** (h) **модель Б, не платил ни разу**: `cycle`
  заполнен (месяц заведения), 3 месяца без оплаты → `owed = OWED + amount*3` (растёт
  на чтении, M1); (i) **partial-overdue**: `paidThisCycle`, `next_due < today` →
  статус `partial-overdue`, а не `partial` (M2); (j) **clampDay след. месяца**:
  `due_day=31, curYM=2026-01` → `next_date=2026-02-28/29`, НЕ `2026-02-31` (M3);
  (k) **Dec→Jan**: `addMonthYM('2025-12',1)='2026-01'` (ведущий ноль); (l) **двойная
  оплата в одном месяце не доначисляет**: два pay подряд при одном `curYM` — база
  `owed_base+cycle` одна, второй pay не докатывает лишнего; (m) **`next_date` задан во
  всех 5 ветках** (нет `NaN` в `days_until`).

### 10. Обновить `CLAUDE.md`
- В «Архитектура» — добавить эндпойнты `GET /api/recurring`,
  `POST /api/recurring/:id/pay`, `PATCH /api/recurring/:id` и лист `Recurring`.
- В «Что нужно знать перед правками» — блок про схему листа `Recurring`, модель
  переносимого долга (ленивое начисление на чтение, персист на запись; **`CYCLE`
  обязателен как якорь — долг растёт всегда, модель Б; пустой `CYCLE` = safe-фолбэк без
  начисления**; в ответе GET раздвоены `owed_base` сырой и `owed` вычисленный; undo
  через `prev`), и что трекер **не двигает балансы** (в отличие от debt-счетов
  Balances, которые ведёт ZenMoney). Добавить `Recurring` в перечень экранов
  `web/index.html`.

### 11. Валидация (финальный шаг)
- Прогнать юнит-тесты, `wrangler dev` + curl локально, задеплоить API и Pages,
  smoke-тест curl'ом на прод (см. Validation Commands).

## Testing Strategy
- **Юнит (обязательно):** вся доменная логика (начисление долга, статусы,
  следующая дата, клэмп дня, сидинг) — pure-функции в `api/test-smoke.mjs`, без
  сети. Это единственный надёжный способ проверить перенос долга и границы месяца.
- **Ручной API:** локальный `wrangler dev` + curl на `GET /api/recurring` и
  `POST /api/recurring/:id/pay` (полная и частичная оплата, дата доплаты), проверить
  корректность `owed`/`status`/`next_date` в ответе и запись в лист.
- **Фронт:** визуальная проверка карточек во всех четырёх статусах, bottom-sheet
  оплаты, тост с undo, поведение при пустом токене (открыть настройки), смена месяца
  (проверить, что done/pending пересчитывается по активной зоне).
- **Edge-кейсы:** due_day=31 в феврале; частичная оплата с переносом через границу
  месяца (кейс ВТБ); переплата (owed уходит в ≤0); нетронутый кредит с заполненным
  `CYCLE` растёт каждый месяц (модель Б); пустой `CYCLE` = safe-фолбэк без начисления;
  просроченный `next_due` → partial-overdue; undo после смены месяца (через `prev`);
  двойной тап «Внести» (идемпотентность на уровне UI — блокировать кнопку).

## Acceptance Criteria
- Лист `Recurring` существует, скрыты `id`/`CYCLE`, кредиты засеяны, косметика
  применена; лист не влияет на существующие эндпойнты (balances/day/events).
- `GET /api/recurring` возвращает для каждого кредита корректные `owed`, `status`
  (done/partial/pending/overdue) и `next_date`, вычисленные по активной зоне; лист
  при чтении не переписывается.
- `POST /api/recurring/:id/pay` с `{full:true}` закрывает долг (owed→≤0, статус
  done); с `{amount, next_due}` уменьшает долг, ставит дату доплаты, статус partial;
  запись персистится в правильную строку листа.
- Недоплаченный остаток корректно переносится и суммируется с нормой следующего
  месяца (ленивое начисление); пропуск месяца довзыскивается. **Кредит, по которому ни
  разу не платили (заполнен `CYCLE`), тоже растёт каждый месяц на `amount`** (модель Б,
  подтверждена Даниилом) — начисление на чтении, без записи.
- Undo оплаты восстанавливает СЫРОЙ `owed_base` и `cycle` (через `prev` из ответа
  `pay`), а не вычисленный `owed`; повторный GET после undo не задваивает долг на стыке
  месяца.
- Экран `recurring` доступен из nav, показывает карточки во всех статусах, оплата
  через bottom-sheet работает, тост с undo откатывает оплату.
- Все юнит-тесты в `api/test-smoke.mjs` зелёные.
- `web/sw.js` `CACHE` забамплен; `CLAUDE.md` описывает лист и эндпойнты.
- Ни один финансовый баланс (`Balances`/`Events`) не изменяется действиями трекера.

## Validation Commands
Execute these commands to validate the task is complete:

- `cd api && node test-smoke.mjs` — юнит-тесты pure-логики (включая новые
  recurring-кейсы); ожидать «все тесты прошли» без падений.
- `node --check api/src/index.js` — синтаксическая проверка воркера.
- `node --check web/config.js` — проверка фронтового модуля (index.html — inline,
  проверяется в браузере).
- `DRY_RUN=1 node scripts/create-recurring-sheet.mjs` — превью создания/сидинга
  листа без записи.
- `node scripts/create-recurring-sheet.mjs` — создать и засеять лист `Recurring`.
- `cd api && npx wrangler@latest dev` затем
  `curl -s localhost:8787/api/recurring -H "Authorization: Bearer $APP_TOKEN"` —
  локальная проверка чтения.
- `cd api && npx wrangler@latest deploy` — деплой API.
- `curl -s 'https://finance.daniilkravchenko.com/api/recurring' -H "Authorization: Bearer $APP_TOKEN"`
  — smoke прод-чтения.
- `curl -s -X POST 'https://finance.daniilkravchenko.com/api/recurring/rec_tbank_cc/pay' -H "Authorization: Bearer $APP_TOKEN" -H 'Content-Type: application/json' -d '{"full":true}'`
  — smoke оплаты (на реальном id после сидинга).
- `npx wrangler@latest pages deploy web --project-name=finance-web` — деплой сайта.

## Notes
- **Данные от Даниила ещё не пришли.** Список кредитов (название, месячная сумма, до
  какого числа, текущий причитающийся долг) вписывается в `CREDITS` в
  `scripts/create-recurring-sheet.mjs` перед запуском шага 2. До этого — плейсхолдеры;
  архитектура и код от конкретных значений не зависят.
- **`APP_TOKEN` для curl** — из `api/.dev.vars` / секрета, НЕ хардкодить в команды,
  попадающие в git.
- **Почему ленивое начисление, а не cron:** проект избегает лишней инфраструктуры;
  долг детерминированно выводится из `owed_base`+`cycle`+календаря на чтение, а
  персист происходит на любой записи — это переживает пропуски и не требует
  планировщика (в отличие от ZenMoney-поллера, которому нужен реальный опрос).
- **Раздельность с debt-счетами Balances:** кредиты уже есть как debt-счета на
  `Balances` (миграция v4, баланс ведёт ZenMoney). Трекер `Recurring` — про *график
  обязательств*, не про *остаток долга по телу кредита*. Пересечения ключей нет: id
  трекера (`rec_*`) отдельны от id счетов.
- **Идемпотентность оплаты:** в MVP нет `client_id` для recurring (действие ручное,
  редкое). Двойной тап предотвращается блокировкой кнопки в UI. Если позже
  понадобится — добавить `client_id` и скан по листу, как в `createEvent`.
- **Timezone на границе месяца (ограничение MVP).** `cycle` персистится под зоной,
  активной в момент оплаты; `curYM`/`todayYMD` тоже из активной KV-зоны. Оплата в ночь
  конца месяца под опережающей зоной может продвинуть `cycle` на новый месяц чуть
  раньше, чем под прежней. `monthsElapsed` защищён `Math.max(0,…)` — отрицательного
  начисления не будет, но граничный месяц может недоначислиться для «отставшей» зоны.
  Редкий кейс. Принять как ограничение MVP либо (если станет важно) хранить `cycle` в
  фиксированной зоне (UTC/Bangkok) независимо от зоны отображения.
- **Модель Б подтверждена Даниилом (2026-07-08): долг растёт всегда**, даже по
  нетронутому кредиту — для этого `CYCLE` обязателен как якорь начисления (см. «Сидинг»).
- **Альтернатива, если Даниил передумает про авто-накопление:** можно отключить
  ленивое начисление (никогда не растить `owed` по календарю) и оставить `owed`
  чисто ручным — тогда `Recurring` станет простым «сколько осталось», а перенос
  между месяцами делает пользователь руками. Модель Б (авто-перенос) — выбор Даниила;
  фолбэк оставлен на случай пересмотра.
