// Unit smoke-tests for the API's pure logic (no fetch / no Sheets calls).
// These are inline copies of the pure functions in src/index.js — keep them in
// sync when the source changes. Run: node test-smoke.mjs

const WEEKDAYS_RU = ['вс','пн','вт','ср','чт','пт','сб'];
const MONTHS_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const pad = (n) => String(n).padStart(2, '0');

const CURRENCY_TOKEN_RE = /(?<![\p{L}\p{N}_])(usdt|rub|руб|thb|бат|baht|vnd|донг)(?![\p{L}\p{N}_])/giu;
const TOKEN_CURRENCY = {
  usdt: 'USDT',
  rub: 'RUB', руб: 'RUB',
  thb: 'THB', бат: 'THB', baht: 'THB',
  vnd: 'VND', донг: 'VND',
};

const ACCOUNT_TOKEN_RE = /(?<![\p{L}\p{N}_])(нал|наличка|наличкой|наличные|наличными|cash|кэш)(?![\p{L}\p{N}_])/giu;
const TOKEN_ACCOUNT = { нал:'cash', наличка:'cash', наличкой:'cash', наличные:'cash', наличными:'cash', cash:'cash', 'кэш':'cash' };

function parseExpense(input) {
  let text = input.replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('empty input');

  let currency = null;
  const tokens = [...text.matchAll(CURRENCY_TOKEN_RE)];
  if (tokens.length === 1) {
    const tok = tokens[0][1].toLowerCase();
    currency = TOKEN_CURRENCY[tok] || null;
    text = text.replace(CURRENCY_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  }

  let account = null;
  const accTokens = [...text.matchAll(ACCOUNT_TOKEN_RE)];
  if (accTokens.length === 1) {
    const atok = accTokens[0][1].toLowerCase();
    account = TOKEN_ACCOUNT[atok] || null;
    text = text.replace(ACCOUNT_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
  }

  const matches = [...text.matchAll(/\d+/g)];
  if (matches.length === 0) throw new Error('no amount found');
  const last = matches[matches.length - 1];
  const amount = parseInt(last[0], 10);
  if (!amount || amount < 1) throw new Error('invalid amount');
  const before = text.slice(0, last.index);
  const after = text.slice(last.index + last[0].length);
  let description = (before + ' ' + after).replace(/\s+/g, ' ').trim();
  description = description.replace(/[\s,;:.]+$/, '').replace(/^[\s,;:.]+/, '');
  if (!description) description = '—';
  return { description, amount, currency, account };
}

function zoneContext(nowISO, tz) {
  const now = nowISO ? new Date(nowISO) : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return contextFromYMD(parseInt(parts.year, 10), parseInt(parts.month, 10), parseInt(parts.day, 10));
}

function contextFromYMD(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  const weekdayRu = WEEKDAYS_RU[dt.getUTCDay()];
  return {
    year, month, day, weekdayRu, monthEn: MONTHS_EN[month-1],
    sectionHeader: `## ${pad(day)}.${pad(month)}.${year}, ${weekdayRu}`,
  };
}

function dateInZone(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// === Sheets row <-> event mapping (pure) ===

const EVENT_COLS = ['when', 'type', 'from', 'to', 'amount', 'amount_to', 'note', 'id', 'at', 'client_id', 'log_only'];

// Display string for the Events `when` column (in `tz`). Noon-exact = backdate
// placeholder → date only; any other time → `DD.MM.YYYY HH:MM`. Derived from `at`.
function formatWhen(iso, tz) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  const date = `${p.day}.${p.month}.${p.year}`;
  if (p.hour === '12' && p.minute === '00' && p.second === '00') return date;
  return `${date} ${p.hour}:${p.minute}`;
}

const truthy = (v) => v === true || (typeof v === 'string' && v.trim().toUpperCase() === 'TRUE');

function rowToEvent(r) {
  const cell = (i) => (r[i] === undefined || r[i] === '' ? null : r[i]);
  const num = (i) => { const v = cell(i); if (v == null) return null; return typeof v === 'number' ? v : parseFloat(v); };
  // Column 0 is the display-only `when` string (derived from `at`) — ignored here.
  return {
    type: cell(1) != null ? String(cell(1)) : null,
    from: cell(2) != null ? String(cell(2)) : null,
    to: cell(3) != null ? String(cell(3)) : null,
    amount: num(4),
    amount_to: num(5),
    note: cell(6) != null ? String(cell(6)) : null,
    id: cell(7) != null ? String(cell(7)) : null,
    at: cell(8) != null ? String(cell(8)) : null,
    client_id: cell(9) != null ? String(cell(9)) : null,
    log_only: truthy(r[10]),
  };
}

function eventToRow(ev, tz) {
  return EVENT_COLS.map((c) => {
    if (c === 'when') return formatWhen(ev.at, tz);
    if (c === 'log_only') return ev.log_only ? true : '';
    const v = ev[c];
    return v == null ? '' : v;
  });
}

// Inline copy of the per-account mapping inside readBalances (src/index.js): turns a
// Balances row (id/name/amount/currency + hidden marker in column G/index 6) into an
// account object. Kept in sync with src/index.js.
function balanceRowToAccount(r) {
  return {
    id: String(r[0]),
    name: r[1] != null ? String(r[1]) : '',
    amount: typeof r[2] === 'number' ? r[2] : parseFloat(r[2]) || 0,
    currency: r[3] != null ? String(r[3]) : '',
    hidden: truthy(r[6]),
  };
}

// === EVENTS pure logic ===

function validateEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'invalid body' };
  const types = ['income', 'transfer', 'exchange', 'expense'];
  if (!types.includes(body.type)) return { ok: false, message: 'type must be income/transfer/exchange/expense' };
  if (typeof body.amount !== 'number' || !isFinite(body.amount) || body.amount <= 0) return { ok: false, message: 'amount must be positive number' };
  if (body.type === 'expense') {
    if (typeof body.from !== 'string' || !body.from) return { ok: false, message: 'from required for expense' };
  } else {
    if (typeof body.to !== 'string' || !body.to) return { ok: false, message: 'to required' };
  }
  if (body.type === 'transfer' || body.type === 'exchange') {
    if (typeof body.from !== 'string' || !body.from) return { ok: false, message: 'from required for transfer/exchange' };
    if (body.from === body.to) return { ok: false, message: 'from and to must differ' };
  }
  if (body.type === 'exchange') {
    if (typeof body.amount_to !== 'number' || !isFinite(body.amount_to) || body.amount_to <= 0) return { ok: false, message: 'amount_to must be positive number' };
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return { ok: false, message: 'note must be string' };
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'string') return { ok: false, message: 'at must be ISO string' };
    const d = new Date(body.at);
    if (isNaN(d.getTime())) return { ok: false, message: 'at is not valid date' };
    if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return { ok: false, message: 'at cannot be in the future' };
  }
  if (body.client_id !== undefined && body.client_id !== null) {
    if (typeof body.client_id !== 'string' || body.client_id.length > 64) return { ok: false, message: 'client_id must be string ≤64 chars' };
  }
  if (body.log_only !== undefined && body.log_only !== null && typeof body.log_only !== 'boolean') {
    return { ok: false, message: 'log_only must be boolean' };
  }
  return { ok: true };
}

function findAccount(accounts, id) { const a = accounts.find(x => x.id === id); if (!a) throw new Error(`unknown: ${id}`); return a; }
function roundCents(accounts) { for (const a of accounts) a.amount = Math.round(a.amount * 100) / 100; return accounts; }
function applyMutation(accounts, ev) {
  if (ev.type === 'income') findAccount(accounts, ev.to).amount += ev.amount;
  else if (ev.type === 'expense') findAccount(accounts, ev.from).amount -= ev.amount;
  else if (ev.type === 'transfer') {
    const f = findAccount(accounts, ev.from), t = findAccount(accounts, ev.to);
    if (f.currency !== t.currency) throw new Error('transfer requires same currency');
    f.amount -= ev.amount; t.amount += ev.amount;
  } else if (ev.type === 'exchange') {
    findAccount(accounts, ev.from).amount -= ev.amount;
    findAccount(accounts, ev.to).amount += ev.amount_to;
  }
  return roundCents(accounts);
}
function reverseMutation(accounts, ev) {
  if (ev.type === 'income') findAccount(accounts, ev.to).amount -= ev.amount;
  else if (ev.type === 'expense') findAccount(accounts, ev.from).amount += ev.amount;
  else if (ev.type === 'transfer') { findAccount(accounts, ev.from).amount += ev.amount; findAccount(accounts, ev.to).amount -= ev.amount; }
  else if (ev.type === 'exchange') { findAccount(accounts, ev.from).amount += ev.amount; findAccount(accounts, ev.to).amount -= ev.amount_to; }
  return roundCents(accounts);
}

function applySnapshot(accounts, snapshots) {
  const next = accounts.map((a) => ({ ...a }));
  const byId = {};
  for (const a of next) byId[a.id] = a;
  for (const s of snapshots) {
    if (!byId[s.account]) throw new Error(`unknown account: ${s.account}`);
    byId[s.account].amount = s.amount;
  }
  return roundCents(next);
}

const sampleAccounts = () => ([
  { id: 'cash', name: 'Налом', amount: 5000, currency: 'THB' },
  { id: 'bybit', name: 'Bybit', amount: 1000, currency: 'USDT' },
  { id: 'maxswap', name: 'maxswap', amount: 50, currency: 'USDT' },
  { id: 'card_t', name: 'Карта Т', amount: 5000, currency: 'RUB' },
]);
const acc = (accounts, id) => accounts.find(a => a.id === id).amount;

// === TESTS ===

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`); }
}

console.log('\n=== parseExpense ===');
eq(parseExpense('кофе 350'), { description: 'кофе', amount: 350, currency: null, account: null }, '"кофе 350" (no token → currency=null → routes to PRIMARY_ACCOUNT)');
eq(parseExpense('350 кофе'), { description: 'кофе', amount: 350, currency: null, account: null }, '"350 кофе" (sum first, but desc captured)');
eq(parseExpense('кофе 1300'), { description: 'кофе', amount: 1300, currency: null, account: null }, '"кофе 1300" (no space — write big numbers without space)');
eq(parseExpense('Ресторан Мишлен на 2 530'), { description: 'Ресторан Мишлен на 2', amount: 530, currency: null, account: null }, '"Ресторан Мишлен на 2 530" (last number wins → 530)');
eq(parseExpense('массаж 1300'), { description: 'массаж', amount: 1300, currency: null, account: null }, '"массаж 1300" (no space)');
eq(parseExpense('  кофе   350  '), { description: 'кофе', amount: 350, currency: null, account: null }, 'trim+collapse spaces');
eq(parseExpense('фитнес-зал на месяц 1800'), { description: 'фитнес-зал на месяц', amount: 1800, currency: null, account: null }, 'multi-word desc');
try { parseExpense(''); console.log('  ✗ empty should throw'); fail++; } catch { console.log('  ✓ empty throws'); pass++; }
try { parseExpense('кофе'); console.log('  ✗ no number should throw'); fail++; } catch { console.log('  ✓ "кофе" (no amount) throws'); pass++; }

// Currency hint
eq(parseExpense('перевод другу 26 usdt'), { description: 'перевод другу', amount: 26, currency: 'USDT', account: null }, '"... 26 usdt" → USDT');
eq(parseExpense('подписка 500 руб'), { description: 'подписка', amount: 500, currency: 'RUB', account: null }, '"... 500 руб" → RUB');
eq(parseExpense('steam 15 rub'), { description: 'steam', amount: 15, currency: 'RUB', account: null }, '"... 15 rub" → RUB (latin)');
eq(parseExpense('usdt 26'), { description: '—', amount: 26, currency: 'USDT', account: null }, '"usdt 26" (token first, no desc → "—")');
eq(parseExpense('платил usdt за хостинг 12'), { description: 'платил за хостинг', amount: 12, currency: 'USDT', account: null }, 'token in the middle');
eq(parseExpense('тест USDT 10'), { description: 'тест', amount: 10, currency: 'USDT', account: null }, 'USDT uppercase');
eq(parseExpense('тест Руб 100'), { description: 'тест', amount: 100, currency: 'RUB', account: null }, '"Руб" capitalized');
eq(parseExpense('рубероид на крышу 1500'), { description: 'рубероид на крышу', amount: 1500, currency: null, account: null }, '"рубероид" не матчит руб');
eq(parseExpense('купил рубашку 800'), { description: 'купил рубашку', amount: 800, currency: null, account: null }, '"рубашку" не матчит руб');
eq(parseExpense('обмен usdt в rub 100'), { description: 'обмен usdt в rub', amount: 100, currency: null, account: null }, 'два токена → ambiguous, currency=null');
eq(parseExpense('фо бо 50 бат'), { description: 'фо бо', amount: 50, currency: 'THB', account: null }, '"... 50 бат" → THB');
eq(parseExpense('massage 200 baht'), { description: 'massage', amount: 200, currency: 'THB', account: null }, '"... 200 baht" → THB (latin)');
eq(parseExpense('такси 80000 донг'), { description: 'такси', amount: 80000, currency: 'VND', account: null }, '"... 80000 донг" → VND');
eq(parseExpense('обед 120000 vnd'), { description: 'обед', amount: 120000, currency: 'VND', account: null }, '"... 120000 vnd" → VND (latin)');
eq(parseExpense('купил батут 3000'), { description: 'купил батут', amount: 3000, currency: null, account: null }, '"батут" не матчит бат');

// Account hint (names a specific account when several share a currency: cash vs truemoney)
eq(parseExpense('такси 80 нал'), { description: 'такси', amount: 80, currency: null, account: 'cash' }, '"... 80 нал" → account=cash');
eq(parseExpense('кофе 350'), { description: 'кофе', amount: 350, currency: null, account: null }, '"кофе 350" → account=null (нет токена)');
eq(parseExpense('налог 500'), { description: 'налог', amount: 500, currency: null, account: null }, '"налог" не матчит нал (граница слова)');
eq(parseExpense('обед 200 бат нал'), { description: 'обед', amount: 200, currency: 'THB', account: 'cash' }, '"... 200 бат нал" → currency=THB И account=cash');
eq(parseExpense('нал 100 cash'), { description: 'нал cash', amount: 100, currency: null, account: null }, '"нал 100 cash" → два account-токена → account=null (токены не вырезаны, guard «ровно один»)');
eq(parseExpense('кофе 350 cash'), { description: 'кофе', amount: 350, currency: null, account: 'cash' }, '"кофе 350 cash" → account=cash');

console.log('\n=== zoneContext / dateInZone (parameterized timezone) ===');
const TZ = 'Asia/Bangkok';
const ctx29 = zoneContext('2026-04-29T08:00:00Z', TZ); // 15:00 in Bangkok same day
eq(ctx29.sectionHeader, '## 29.04.2026, ср', 'section header 29.04.2026 = ср');
eq(ctx29.monthEn, 'april', 'monthEn april');
const ctxLateNight = zoneContext('2026-04-30T17:30:00Z', TZ); // 00:30 May 1 in Bangkok
eq(ctxLateNight.day, 1, 'late UTC night flips to next day in Bangkok');
eq(ctxLateNight.monthEn, 'may', 'late UTC night flips to may');
eq(dateInZone('2026-05-08T09:52:50.378Z', TZ), '2026-05-08', 'UTC morning → same Bangkok day');
eq(dateInZone('2026-04-30T17:30:00Z', TZ), '2026-05-01', 'UTC night → next Bangkok day');
eq(dateInZone('2026-05-08T12:00:00+07:00', TZ), '2026-05-08', 'noon Bangkok offset → same day');
// Same instant, a different zone buckets to a different day — the whole point of
// making the zone a parameter. 23:30 UTC = 06:30 next day in Bangkok, still 23:30 in Moscow.
eq(dateInZone('2026-05-08T23:30:00Z', 'Asia/Bangkok'), '2026-05-09', 'late UTC → next day in Bangkok (+07)');
eq(dateInZone('2026-05-08T23:30:00Z', 'Europe/Moscow'), '2026-05-09', 'same instant in Moscow (+03) → 02:30, next day');
eq(dateInZone('2026-05-08T20:30:00Z', 'Europe/Moscow'), '2026-05-08', '20:30 UTC = 23:30 Moscow → same day');
eq(dateInZone('2026-05-08T20:30:00Z', 'Asia/Bangkok'), '2026-05-09', '20:30 UTC = 03:30 Bangkok next day');
// dateParam path: weekday of a literal calendar date is zone-free.
eq(contextFromYMD(2026, 5, 8).sectionHeader, '## 08.05.2026, пт', 'contextFromYMD weekday is zone-free');

console.log('\n=== formatWhen ===');
eq(formatWhen('2026-05-08T12:00:00+07:00', TZ), '08.05.2026', 'noon placeholder → date only');
eq(formatWhen('2026-05-08T09:52:50.378Z', TZ), '08.05.2026 16:52', 'real time → date + HH:MM (Bangkok)');
eq(formatWhen('2026-05-08T09:52:50.378Z', 'Europe/Moscow'), '08.05.2026 12:52', 'same instant in Moscow → 12:52');
eq(formatWhen('', TZ), '', 'empty → empty');

console.log('\n=== rowToEvent / eventToRow (round-trip) ===');
// Keys are in rowToEvent's output order so JSON round-trip compares equal.
const ev1 = { type: 'expense', from: 'cash', to: null, amount: 350, amount_to: null, note: 'кофе', id: 'ev_abc', at: '2026-05-08T12:00:00+07:00', client_id: null, log_only: false };
eq(eventToRow(ev1, TZ), ['08.05.2026', 'expense', 'cash', '', 350, '', 'кофе', 'ev_abc', '2026-05-08T12:00:00+07:00', '', ''], 'event → row (when derived, nulls become "", log_only false → "")');
eq(rowToEvent(eventToRow(ev1, TZ)), ev1, 'row → event round-trips');
const ev2 = { type: 'exchange', from: 'bybit', to: 'cash', amount: 300, amount_to: 9400, note: null, id: 'ev_x', at: '2026-05-08T09:52:50.378Z', client_id: 'c_123', log_only: false };
eq(rowToEvent(eventToRow(ev2, TZ)), ev2, 'exchange with client_id round-trips');
// log_only=true: row's last cell is boolean true, round-trips back to log_only:true
const ev3 = { type: 'expense', from: 'bybit', to: null, amount: 26, amount_to: null, note: 'mirrored op', id: 'ev_lo', at: '2026-05-08T09:52:50.378Z', client_id: 'zm_42', log_only: true };
eq(eventToRow(ev3, TZ)[10], true, 'log_only=true → row last cell is boolean true');
eq(rowToEvent(eventToRow(ev3, TZ)), ev3, 'log_only=true event round-trips');
// Sheets may return numeric cells as numbers and omit trailing empties — emulate that
eq(rowToEvent(['16.04.2026', 'income', '', 'bybit', 2499, '', 'ЗП', 'ev_y', '2026-05-06T12:00:00+07:00']),
   { type: 'income', from: null, to: 'bybit', amount: 2499, amount_to: null, note: 'ЗП', id: 'ev_y', at: '2026-05-06T12:00:00+07:00', client_id: null, log_only: false },
   'short row (trailing empties omitted) parses with nulls, log_only false');

console.log('\n=== Balances row → account (hidden marker, column G) ===');
// G as Sheets boolean true → hidden:true
eq(balanceRowToAccount(['bybit', 'Bybit', 0, 'USDT', '', '', true]).hidden, true, 'G boolean true → hidden:true');
// G as RAW string 'TRUE' → hidden:true
eq(balanceRowToAccount(['cash', 'Cash', 100, 'THB', '', '', 'TRUE']).hidden, true, "G string 'TRUE' → hidden:true");
// G as empty string → hidden:false
eq(balanceRowToAccount(['bidv', 'BIDV', 792964, 'VND', '', '', '']).hidden, false, "G empty string → hidden:false");
// G absent (short row) → hidden:false
eq(balanceRowToAccount(['tbank_debit', 'T-Bank', 5000, 'RUB']).hidden, false, 'G absent → hidden:false');

console.log('\n=== validateEvent ===');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100 }).ok, true, 'income OK');
eq(validateEvent({ type: 'transfer', from: 'bybit', to: 'maxswap', amount: 50 }).ok, true, 'transfer OK');
eq(validateEvent({ type: 'exchange', from: 'bybit', to: 'cash', amount: 100, amount_to: 3500 }).ok, true, 'exchange OK');
eq(validateEvent({ type: 'wat', to: 'bybit', amount: 100 }).ok, false, 'unknown type rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 0 }).ok, false, 'zero amount rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: -10 }).ok, false, 'negative amount rejected');
eq(validateEvent({ type: 'transfer', to: 'bybit', amount: 10 }).ok, false, 'transfer w/o from rejected');
eq(validateEvent({ type: 'transfer', from: 'a', to: 'a', amount: 10 }).ok, false, 'same from/to rejected');
eq(validateEvent({ type: 'exchange', from: 'a', to: 'b', amount: 100 }).ok, false, 'exchange w/o amount_to rejected');
eq(validateEvent({ type: 'expense', from: 'bybit', amount: 600 }).ok, true, 'expense OK');
eq(validateEvent({ type: 'expense', amount: 600 }).ok, false, 'expense w/o from rejected');
eq(validateEvent({ type: 'expense', from: 'bybit', amount: 0 }).ok, false, 'expense zero amount rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, at: '2026-05-06T10:00:00+07:00' }).ok, true, 'backdate OK');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, at: 'not-a-date' }).ok, false, 'invalid at rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, at: '2099-01-01T00:00:00Z' }).ok, false, 'far future at rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, client_id: 'abc' }).ok, true, 'client_id OK');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, client_id: 'x'.repeat(65) }).ok, false, 'client_id >64 rejected');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, log_only: true }).ok, true, 'log_only boolean OK');
eq(validateEvent({ type: 'income', to: 'bybit', amount: 100, log_only: 'yes' }).ok, false, 'log_only non-boolean rejected');

console.log('\n=== applyMutation / reverseMutation ===');
let a = sampleAccounts();
applyMutation(a, { type: 'income', to: 'bybit', amount: 2499 });
eq(acc(a, 'bybit'), 3499, 'income +2499 → bybit');

a = sampleAccounts();
applyMutation(a, { type: 'transfer', from: 'bybit', to: 'maxswap', amount: 600 });
eq(acc(a, 'bybit'), 400, 'transfer bybit -600');
eq(acc(a, 'maxswap'), 650, 'transfer maxswap +600');

a = sampleAccounts();
applyMutation(a, { type: 'exchange', from: 'bybit', to: 'cash', amount: 200, amount_to: 6200 });
eq(acc(a, 'bybit'), 800, 'exchange bybit -200');
eq(acc(a, 'cash'), 11200, 'exchange cash +6200');

a = sampleAccounts();
applyMutation(a, { type: 'expense', from: 'bybit', amount: 600 });
eq(acc(a, 'bybit'), 400, 'expense bybit -600');

a = sampleAccounts();
const evE = { type: 'expense', from: 'bybit', amount: 600 };
applyMutation(a, evE); reverseMutation(a, evE);
eq(acc(a, 'bybit'), 1000, 'reverse expense returns to original');

a = sampleAccounts();
const ev = { type: 'income', to: 'bybit', amount: 2499 };
applyMutation(a, ev); reverseMutation(a, ev);
eq(acc(a, 'bybit'), 1000, 'reverse income returns to original');

a = sampleAccounts();
const ev2x = { type: 'exchange', from: 'bybit', to: 'cash', amount: 200, amount_to: 6200 };
applyMutation(a, ev2x); reverseMutation(a, ev2x);
eq(acc(a, 'bybit'), 1000, 'reverse exchange bybit');
eq(acc(a, 'cash'), 5000, 'reverse exchange cash');

a = sampleAccounts();
try { applyMutation(a, { type: 'transfer', from: 'bybit', to: 'cash', amount: 100 }); console.log('  ✗ transfer different currency should throw'); fail++; }
catch { console.log('  ✓ transfer different currency throws'); pass++; }

a = sampleAccounts();
try { applyMutation(a, { type: 'income', to: 'wat', amount: 10 }); console.log('  ✗ unknown account should throw'); fail++; }
catch { console.log('  ✓ unknown account throws'); pass++; }

a = sampleAccounts();
for (let i = 0; i < 10; i++) applyMutation(a, { type: 'income', to: 'bybit', amount: 0.1 });
eq(acc(a, 'bybit'), 1001, 'no float drift after 10×0.1');

console.log('\n=== applySnapshot (mirror source balances, SET not delta) ===');
a = sampleAccounts();
let snap = applySnapshot(a, [{ account: 'bybit', amount: 745.27 }]);
eq(acc(snap, 'bybit'), 745.27, 'snapshot SETs bybit to source value (not a delta)');
eq(acc(snap, 'cash'), 5000, 'unlisted account untouched');
eq(acc(a, 'bybit'), 1000, 'original accounts not mutated (works on a copy)');

snap = applySnapshot(sampleAccounts(), [{ account: 'bybit', amount: 0 }, { account: 'card_t', amount: 5650 }]);
eq(acc(snap, 'bybit'), 0, 'batch snapshot: bybit → 0');
eq(acc(snap, 'card_t'), 5650, 'batch snapshot: card_t → 5650 (anchor fix)');

snap = applySnapshot(sampleAccounts(), [{ account: 'maxswap', amount: 7.366666 }]);
eq(acc(snap, 'maxswap'), 7.37, 'snapshot rounds to cents');

try { applySnapshot(sampleAccounts(), [{ account: 'nope', amount: 1 }]); console.log('  ✗ unknown account should throw'); fail++; }
catch { console.log('  ✓ snapshot unknown account throws (batch rejected)'); pass++; }

console.log('\n=== edit event (reverse old + apply new) ===');
// PATCH /api/event/:id math: take the live balances, reverse the stored event,
// then apply the corrected one. Net effect == as if the corrected event had been
// logged in the first place.
const applyEdit = (accounts, oldEv, newEv) => applyMutation(reverseMutation(accounts, oldEv), newEv);

a = sampleAccounts();
const oldExp = { type: 'expense', from: 'bybit', amount: 600 };
applyMutation(a, oldExp); // live state after original log: bybit 400
applyEdit(a, oldExp, { type: 'expense', from: 'bybit', amount: 500 });
eq(acc(a, 'bybit'), 500, 'edit expense 600→500 leaves bybit as if 500 logged');

a = sampleAccounts();
const oldInc = { type: 'income', to: 'bybit', amount: 2499 };
applyMutation(a, oldInc); // bybit 3499
applyEdit(a, oldInc, { type: 'expense', from: 'cash', amount: 1000 }); // change type + account
eq(acc(a, 'bybit'), 1000, 'edit reverts wrong income off bybit');
eq(acc(a, 'cash'), 4000, 'edit applies corrected expense on cash');

console.log('\n=== PATCH log_only matrix (conditional reverse/apply) ===');
// Mirrors patchEventById: reverse OLD only if !old.log_only, apply NEW only if
// !new.log_only — a log_only event never moved the balance.
const applyPatch = (accs, oldEv, newEv) => {
  let a = accs;
  if (!oldEv.log_only) a = reverseMutation(a, oldEv);
  if (!newEv.log_only) a = applyMutation(a, newEv);
  return a;
};

// both false: normal expense 600 (live 400) → patch to expense 500 → bybit 500.
a = sampleAccounts();
const pOldF = { type: 'expense', from: 'bybit', amount: 600, log_only: false };
applyMutation(a, pOldF); // live: bybit 400
applyPatch(a, pOldF, { type: 'expense', from: 'bybit', amount: 500, log_only: false });
eq(acc(a, 'bybit'), 500, 'patch both-false: 600→500 leaves bybit 500');

// old log_only true → new false: live bybit 1000 (log_only never moved it) →
// patch to normal expense 500 → bybit 500 (apply only, no reverse).
a = sampleAccounts(); // bybit 1000, old log_only never mutated it
const pOldLO = { type: 'expense', from: 'bybit', amount: 600, log_only: true };
applyPatch(a, pOldLO, { type: 'expense', from: 'bybit', amount: 500, log_only: false });
eq(acc(a, 'bybit'), 500, 'patch old-logonly→normal: apply only → bybit 500');

// old false → new log_only true: normal expense 600 applied (live 400) → patch to
// log_only → reverse only → bybit back to 1000.
a = sampleAccounts();
const pOldN = { type: 'expense', from: 'bybit', amount: 600, log_only: false };
applyMutation(a, pOldN); // live: bybit 400
applyPatch(a, pOldN, { type: 'expense', from: 'bybit', amount: 600, log_only: true });
eq(acc(a, 'bybit'), 1000, 'patch normal→logonly: reverse only → bybit 1000');

// both true: balance untouched (1000).
a = sampleAccounts();
const pBothLO_old = { type: 'expense', from: 'bybit', amount: 600, log_only: true };
applyPatch(a, pBothLO_old, { type: 'expense', from: 'bybit', amount: 500, log_only: true });
eq(acc(a, 'bybit'), 1000, 'patch both-logonly: no-op → bybit 1000');

console.log('\n=== DELETE log_only matrix (conditional reverse) ===');
// Mirrors deleteEventById: reverse only when !target.log_only.
const applyDelete = (accs, target) => (target.log_only ? accs : reverseMutation(accs, target));

a = sampleAccounts();
const dNormal = { type: 'expense', from: 'bybit', amount: 600, log_only: false };
applyMutation(a, dNormal); // live: bybit 400
applyDelete(a, dNormal);
eq(acc(a, 'bybit'), 1000, 'delete normal expense: reverse → bybit 1000');

a = sampleAccounts(); // log_only never mutated: bybit 1000
const dLO = { type: 'expense', from: 'bybit', amount: 600, log_only: true };
applyDelete(a, dLO);
eq(acc(a, 'bybit'), 1000, 'delete log_only expense: no reverse → bybit stays 1000');

// === RECURRING pure logic (inline copies of src/index.js — keep in sync!) ===

const round2 = (x) => Math.round(x * 100) / 100;
const monthIndex = (ym) => { const [y, m] = String(ym).split('-').map(Number); return y * 12 + (m - 1); };
const monthsElapsed = (fromYM, toYM) => Math.max(0, monthIndex(toYM) - monthIndex(fromYM));
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const clampDay = (y, m, d) => Math.min(d, daysInMonth(y, m));
const addMonthYM = (ym, k) => { const idx = monthIndex(ym) + k; return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`; };
const ymdToUTC = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (fromYMD, toYMD) => Math.round((ymdToUTC(toYMD) - ymdToUTC(fromYMD)) / 86400000);

function accrue(rec, curYM) {
  if (!rec.cycle) return { owed: round2(rec.owed || 0), cycle: curYM, accrued: 0 };
  const k = monthsElapsed(rec.cycle, curYM);
  const accrued = round2((rec.amount || 0) * k);
  return { owed: round2((rec.owed || 0) + accrued), cycle: curYM, accrued };
}

function computeRecurringStatus(rec, todayYMD) {
  const curYM = todayYMD.slice(0, 7);
  const [cy, cm] = curYM.split('-').map(Number);
  const owed = accrue(rec, curYM).owed;
  const dueDate = `${curYM}-${pad(clampDay(cy, cm, rec.due_day))}`;
  const nextYM = addMonthYM(curYM, 1);
  const [ny, nm] = nextYM.split('-').map(Number);
  const dueNextMonth = `${nextYM}-${pad(clampDay(ny, nm, rec.due_day))}`;
  const paidThisCycle = !!(rec.last_paid && String(rec.last_paid).slice(0, 7) === curYM);
  const nextDue = rec.next_due || null;

  let status, next_date;
  if (owed <= 0) {
    status = 'done';
    next_date = dueNextMonth;
  } else if (paidThisCycle && (!nextDue || nextDue >= todayYMD)) {
    status = 'partial';
    next_date = nextDue || dueNextMonth;
  } else if (paidThisCycle && nextDue && nextDue < todayYMD) {
    status = 'partial-overdue';
    next_date = nextDue;
  } else if (todayYMD <= dueDate) {
    status = 'pending';
    next_date = dueDate;
  } else {
    status = 'overdue';
    next_date = nextDue || dueDate;
  }
  return { owed, status, next_date, due_date: dueDate, days_until: daysBetween(todayYMD, next_date) };
}

console.log('\n=== recurring: month/day helpers ===');
eq(monthIndex('2026-07'), 2026 * 12 + 6, 'monthIndex 2026-07');
eq(monthsElapsed('2026-05', '2026-07'), 2, 'monthsElapsed 05→07 = 2');
eq(monthsElapsed('2026-07', '2026-05'), 0, 'monthsElapsed backwards clamped to 0');
eq(daysInMonth(2026, 2), 28, 'Feb 2026 = 28 days');
eq(daysInMonth(2028, 2), 29, 'Feb 2028 (leap) = 29 days');
eq(clampDay(2026, 2, 31), 28, 'clampDay 31 in Feb 2026 → 28');
eq(addMonthYM('2025-12', 1), '2026-01', '(k) Dec→Jan rolls year with leading zero'); // case k
eq(addMonthYM('2026-01', 1), '2026-02', 'addMonthYM Jan→Feb');
eq(addMonthYM('2026-07', 5), '2026-12', 'addMonthYM +5 → Dec');

console.log('\n=== recurring: accrue (lazy carry-over, model Б) ===');
// (g) empty cycle → safe fallback, no accrual, owed = OWED as-is
eq(accrue({ owed: 15000, amount: 15000, cycle: '' }, '2026-07').owed, 15000, '(g) empty cycle → no accrual, owed=OWED');
eq(accrue({ owed: 15000, amount: 15000, cycle: '' }, '2026-07').accrued, 0, '(g) empty cycle → accrued 0');
// (h) model Б: never paid, cycle filled, 3 months elapsed → owed grows by amount*3
eq(accrue({ owed: 15000, amount: 15000, cycle: '2026-04' }, '2026-07').owed, 60000, '(h) never paid, cycle set, +3mo → 15000+15000*3');
// (b) partial carry-over: owed_base 7000, prev cycle, amount 15000 → 22000
eq(accrue({ owed: 7000, amount: 15000, cycle: '2026-06' }, '2026-07').owed, 22000, '(b) carry 7000 + norm 15000 → 22000');
// (l) double pay in same month does not re-accrue: same curYM, k=0
eq(accrue({ owed: 5000, amount: 15000, cycle: '2026-07' }, '2026-07').accrued, 0, '(l) same-month pay → no extra accrual');
eq(accrue({ owed: 5000, amount: 15000, cycle: '2026-07' }, '2026-07').owed, 5000, '(l) same-month base unchanged (owed=owed_base)');

console.log('\n=== recurring: computeRecurringStatus ===');
// (a) fully paid this month → done, next = due_day of next month
const sa = computeRecurringStatus({ owed: 0, amount: 15000, due_day: 15, cycle: '2026-07', last_paid: '2026-07-15', next_due: null }, '2026-07-20');
eq(sa.status, 'done', '(a) owed 0 → done');
eq(sa.next_date, '2026-08-15', '(a) next = due_day of next month');
eq(sa.days_until > 0, true, '(a) done: days_until positive (future)');
// (f) overpayment (owed<=0) → done
eq(computeRecurringStatus({ owed: -500, amount: 15000, due_day: 10, cycle: '2026-07', last_paid: '2026-07-05', next_due: null }, '2026-07-20').status, 'done', '(f) owed<0 → done');
// (c) never paid, today <= dueDate → pending, positive days_until
const sc = computeRecurringStatus({ owed: 15000, amount: 15000, due_day: 25, cycle: '2026-07', last_paid: null, next_due: null }, '2026-07-10');
eq(sc.status, 'pending', '(c) today<=due → pending');
eq(sc.next_date, '2026-07-25', '(c) next_date = dueDate');
eq(sc.days_until, 15, '(c) days_until = 15 (positive)');
// (d) never paid, today > dueDate → overdue, days_until <= 0
const sd = computeRecurringStatus({ owed: 15000, amount: 15000, due_day: 5, cycle: '2026-07', last_paid: null, next_due: null }, '2026-07-20');
eq(sd.status, 'overdue', '(d) today>due → overdue');
eq(sd.next_date, '2026-07-05', '(d) next_date = dueDate (no next_due)');
eq(sd.days_until <= 0, true, '(d) overdue: days_until <= 0');
// partial: paid this cycle, owed remains, next_due in the future
const sp = computeRecurringStatus({ owed: 7000, amount: 15000, due_day: 5, cycle: '2026-07', last_paid: '2026-07-05', next_due: '2026-07-25' }, '2026-07-20');
eq(sp.status, 'partial', 'partial: paid + remaining + future next_due');
eq(sp.next_date, '2026-07-25', 'partial next_date = next_due');
eq(sp.days_until, 5, 'partial days_until = 5');
// partial with no next_due → next_date = due_day next month
eq(computeRecurringStatus({ owed: 7000, amount: 15000, due_day: 5, cycle: '2026-07', last_paid: '2026-07-05', next_due: null }, '2026-07-20').next_date, '2026-08-05', 'partial no next_due → next month due_day');
// (i) partial-overdue: paid this cycle, next_due already passed
const si = computeRecurringStatus({ owed: 7000, amount: 15000, due_day: 5, cycle: '2026-07', last_paid: '2026-07-03', next_due: '2026-07-10' }, '2026-07-20');
eq(si.status, 'partial-overdue', '(i) paid + next_due<today → partial-overdue (not partial)');
eq(si.next_date, '2026-07-10', '(i) next_date = next_due');
eq(si.days_until <= 0, true, '(i) partial-overdue days_until <= 0');
// (e) clampDay: due_day=31 in a February month (done branch, next month Feb)
eq(computeRecurringStatus({ owed: 0, amount: 15000, due_day: 31, cycle: '2026-01', last_paid: '2026-01-31', next_due: null }, '2026-01-20').next_date, '2026-02-28', '(e) done next=due_day 31 → clamp Feb 28');
// (j) clampDay of NEXT month specifically (not current): due_day=31, curYM=2026-01, done → 2026-02-28, NOT 2026-02-31
const sj = computeRecurringStatus({ owed: 0, amount: 15000, due_day: 31, cycle: '2026-01', last_paid: '2026-01-15', next_due: null }, '2026-01-15');
eq(sj.next_date, '2026-02-28', '(j) next-month clamp: 2026-02-28 not 2026-02-31');
eq(/^\d{4}-\d{2}-\d{2}$/.test(sj.next_date), true, '(j) next_date is a real YYYY-MM-DD');
// leap-year variant: due_day=31, curYM=2028-01 → 2028-02-29
eq(computeRecurringStatus({ owed: 0, amount: 15000, due_day: 31, cycle: '2028-01', last_paid: '2028-01-10', next_due: null }, '2028-01-10').next_date, '2028-02-29', '(j) leap: next month Feb 29');
// pending with due_day=31 in a short month (current month clamp): April due_day 31 → 2026-04-30
eq(computeRecurringStatus({ owed: 15000, amount: 15000, due_day: 31, cycle: '2026-04', last_paid: null, next_due: null }, '2026-04-10').next_date, '2026-04-30', 'pending: due_day 31 in April → clamp 30');

// (m) next_date defined (no NaN days_until) in ALL five branches
console.log('\n=== recurring: (m) next_date defined in all branches ===');
const branchCases = [
  ['done',            { owed: 0,     amount: 15000, due_day: 15, cycle: '2026-07', last_paid: '2026-07-15', next_due: null },        '2026-07-20'],
  ['partial',         { owed: 7000,  amount: 15000, due_day: 5,  cycle: '2026-07', last_paid: '2026-07-05', next_due: '2026-07-25' }, '2026-07-20'],
  ['partial-overdue', { owed: 7000,  amount: 15000, due_day: 5,  cycle: '2026-07', last_paid: '2026-07-03', next_due: '2026-07-10' }, '2026-07-20'],
  ['pending',         { owed: 15000, amount: 15000, due_day: 25, cycle: '2026-07', last_paid: null,        next_due: null },        '2026-07-10'],
  ['overdue',         { owed: 15000, amount: 15000, due_day: 5,  cycle: '2026-07', last_paid: null,        next_due: null },        '2026-07-20'],
];
for (const [expected, rec, today] of branchCases) {
  const s = computeRecurringStatus(rec, today);
  eq(s.status, expected, `(m) status = ${expected}`);
  eq(typeof s.next_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.next_date), true, `(m) ${expected}: next_date is YYYY-MM-DD`);
  eq(Number.isNaN(s.days_until), false, `(m) ${expected}: days_until is not NaN`);
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
