# План: TrueMoney Wallet как отдельный THB-счёт

**Дата:** 2026-07-12 · **Статус:** в работе

## Зачем

Даниил теперь платит в Таиланде через кошелёк TrueMoney вместо налички. Наличка
(`cash`) остаётся для редких наличных платежей. Оба счёта — THB, оба живут рядом.

**Решения владельца (сессия 2026-07-12):**
- TrueMoney и `cash` **сосуществуют** (не замена). TrueMoney — дефолт для THB, `cash` — по явному токену.
- Пополнение TrueMoney = **transfer-событие** (банк/USDT/нал → truemoney). Механизм уже есть, кода не нужно.

## Развилка, которую это создаёт

Роутинг трат сейчас — **по валюте, не по счёту** (`defaultAccountByCurrency`, `api/src/index.js:132`).
Два THB-счёта (`cash` + `truemoney`) по одной валюте не различить. Значит нужен
**account-token** — ключевое слово в тексте траты, выбирающее счёт на лету.

Дизайн: симметрично существующему currency-token.
- Дефолт для THB → `truemoney` (меняем `DEFAULT_ACCOUNT_THB`).
- Явный токен `нал/cash/кэш` → счёт `cash`.

```
«кофе 350 бат»      → truemoney   (дефолт THB)
«такси 80 нал»      → cash        (account-token)
«кофе 350»          → primary_account (без изменений)
«налог 500»         → primary_account (НЕ cash — граница слова защищает)
```

## Изменения кода (обратимо, тестируемо)

### 1. `api/src/index.js` — parseExpense + роутинг

- Новый `ACCOUNT_TOKEN_RE` с той же unicode-границей слова, что у `CURRENCY_TOKEN_RE`
  (`api/src/index.js:122`) — защита от `налог`/подстрок:
  ```js
  const ACCOUNT_TOKEN_RE = /(?<![\p{L}\p{N}_])(нал|наличка|наличкой|наличные|наличными|cash|кэш)(?![\p{L}\p{N}_])/giu;
  const TOKEN_ACCOUNT = { нал:'cash', наличка:'cash', наличкой:'cash', наличные:'cash', наличными:'cash', cash:'cash', кэш:'cash' };
  ```
- `parseExpense` возвращает доп. поле `account` (alias-ключ, напр. `'cash'`, или `null`).
  Тот же guard «ровно один токен» (`tokens.length === 1`), что у валюты; токен вырезается
  из текста до парсинга суммы.
- `accountAliasById(env)` — симметрично `defaultAccountByCurrency`: `{ cash: env.ACCOUNT_ALIAS_CASH }`.
  Alias → реальный id счёта через env (id не хардкодим).
- `handleQuickExpense` (`api/src/index.js:547`) — приоритет резолва `from`:
  1. `parsed.account` есть → `accountAliasById(env)[parsed.account]` (самый специфичный, побеждает валюту)
  2. иначе `parsed.currency` → currency-default
  3. иначе → `primary_account`

  Неизвестный alias без env-конфига → `error(500, ...)` в стиле существующих проверок.

### 2. `api/test-smoke.mjs` — синхрон инлайн-копии + кейсы

Инлайн-копия `parseExpense`/токенов в тестах должна повторить прод (CLAUDE.md #5). Добавить кейсы:
- `«такси 80 нал»` → `{account:'cash', amount:80, currency:null}`
- `«кофе 350»` → `account:null`
- **`«налог 500»` → `account:null`** (критичный guard: подстрока не ловится)
- `«обед 200 бат нал»` → `currency:'THB'` + `account:'cash'` (оба токена)
- `«нал 100 cash»` (два account-токена) → `account:null` (зеркалит guard «ровно один»)
- `«кофе 350 cash»` → `account:'cash'`
- существующие валютные кейсы — без регресса.

**Критерий готовности:** `cd api && node test-smoke.mjs` — все зелёные, exit 0.

## Изменения конфига (прод — под гейтом, с «go» Даниила)

1. **`api/wrangler.toml`:**
   - `DEFAULT_ACCOUNT_THB = "truemoney"` (было `"cash"`)
   - добавить `ACCOUNT_ALIAS_CASH = "cash"`
2. **Лист `Balances`:** добавить строку счёта `truemoney | TrueMoney | <текущий остаток> | THB`.
   Нужна реальная сумма на кошельке от Даниила (структурная правка листа, не финоперация).
3. **Деплой API:** `npx wrangler@latest deploy` (см. CLAUDE.md «Команды»).
4. **primary_account (опц., ячейка листа, без редеплоя):** если повседневная валюта теперь THB —
   поставить `primary_account = truemoney` в блоке SETTINGS листа `Balances`. Решение Даниила.

## Порядок исполнения

1. Код (1+2) через Workflow → зелёный smoke → `/commit` + `/push`. ← делаю сам, обратимо.
2. Гейт: показать Даниилу, взять остаток TrueMoney + «go» на конфиг/деплой.
3. Конфиг (wrangler + строка Balances) + деплой + smoke-проверка роутинга.
4. Доки: CHANGELOG, CLAUDE.md #7 (parseExpense теперь тянет и account-token).

## Границы

- Фронт **не трогаем**: контракт «≤5–10 сек на захват» (CLAUDE.md #11) держится — просто
  печатаешь «нал». Ни нового поля, ни экрана.
- `Recurring`, snapshot, idempotency, PATCH/DELETE — не затрагиваются: токен влияет только
  на выбор `from` при создании траты, дальше событие обычное.
