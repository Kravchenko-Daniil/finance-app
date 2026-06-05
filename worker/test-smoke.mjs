// Unit smoke-tests for the Worker's pure logic (no fetch / no Sheets calls).
// These are inline copies of the pure functions in src/index.js — keep them in
// sync when the source changes. Run: node test-smoke.mjs

const WEEKDAYS_RU = ['вс','пн','вт','ср','чт','пт','сб'];
const MONTHS_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const pad = (n) => String(n).padStart(2, '0');

const CURRENCY_TOKEN_RE = /(?<![\p{L}\p{N}_])(usdt|rub|руб)(?![\p{L}\p{N}_])/giu;

function parseExpense(input) {
  let text = input.replace(/[\r\n]+/g, ' ').trim();
  if (!text) throw new Error('empty input');

  let currency = null;
  const tokens = [...text.matchAll(CURRENCY_TOKEN_RE)];
  if (tokens.length === 1) {
    const tok = tokens[0][1].toLowerCase();
    currency = tok === 'usdt' ? 'USDT' : 'RUB';
    text = text.replace(CURRENCY_TOKEN_RE, ' ').replace(/\s+/g, ' ').trim();
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
  return { description, amount, currency };
}

function bangkokContext(nowISO) {
  const now = nowISO ? new Date(nowISO) : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const year = parseInt(parts.year, 10), month = parseInt(parts.month, 10), day = parseInt(parts.day, 10);
  const dt = new Date(Date.UTC(year, month - 1, day));
  const weekdayRu = WEEKDAYS_RU[dt.getUTCDay()];
  return {
    year, month, day, weekdayRu, monthEn: MONTHS_EN[month-1],
    sectionHeader: `## ${pad(day)}.${pad(month)}.${year}, ${weekdayRu}`,
  };
}

function bangkokDateOf(iso) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// === Sheets row <-> event mapping (pure) ===

const EVENT_COLS = ['id', 'type', 'from', 'to', 'amount', 'amount_to', 'note', 'at', 'client_id'];

function rowToEvent(r) {
  const cell = (i) => (r[i] === undefined || r[i] === '' ? null : r[i]);
  const num = (i) => { const v = cell(i); if (v == null) return null; return typeof v === 'number' ? v : parseFloat(v); };
  return {
    id: cell(0) != null ? String(cell(0)) : null,
    type: cell(1) != null ? String(cell(1)) : null,
    from: cell(2) != null ? String(cell(2)) : null,
    to: cell(3) != null ? String(cell(3)) : null,
    amount: num(4),
    amount_to: num(5),
    note: cell(6) != null ? String(cell(6)) : null,
    at: cell(7) != null ? String(cell(7)) : null,
    client_id: cell(8) != null ? String(cell(8)) : null,
  };
}

function eventToRow(ev) {
  return EVENT_COLS.map((c) => { const v = ev[c]; return v == null ? '' : v; });
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
eq(parseExpense('кофе 350'), { description: 'кофе', amount: 350, currency: null }, '"кофе 350" (default → cash/THB)');
eq(parseExpense('350 кофе'), { description: 'кофе', amount: 350, currency: null }, '"350 кофе" (sum first, but desc captured)');
eq(parseExpense('кофе 1300'), { description: 'кофе', amount: 1300, currency: null }, '"кофе 1300" (no space — write big numbers without space)');
eq(parseExpense('Ресторан Мишлен на 2 530'), { description: 'Ресторан Мишлен на 2', amount: 530, currency: null }, '"Ресторан Мишлен на 2 530" (last number wins → 530)');
eq(parseExpense('массаж 1300'), { description: 'массаж', amount: 1300, currency: null }, '"массаж 1300" (no space)');
eq(parseExpense('  кофе   350  '), { description: 'кофе', amount: 350, currency: null }, 'trim+collapse spaces');
eq(parseExpense('фитнес-зал на месяц 1800'), { description: 'фитнес-зал на месяц', amount: 1800, currency: null }, 'multi-word desc');
try { parseExpense(''); console.log('  ✗ empty should throw'); fail++; } catch { console.log('  ✓ empty throws'); pass++; }
try { parseExpense('кофе'); console.log('  ✗ no number should throw'); fail++; } catch { console.log('  ✓ "кофе" (no amount) throws'); pass++; }

// Currency hint
eq(parseExpense('перевод другу 26 usdt'), { description: 'перевод другу', amount: 26, currency: 'USDT' }, '"... 26 usdt" → USDT');
eq(parseExpense('подписка 500 руб'), { description: 'подписка', amount: 500, currency: 'RUB' }, '"... 500 руб" → RUB');
eq(parseExpense('steam 15 rub'), { description: 'steam', amount: 15, currency: 'RUB' }, '"... 15 rub" → RUB (latin)');
eq(parseExpense('usdt 26'), { description: '—', amount: 26, currency: 'USDT' }, '"usdt 26" (token first, no desc → "—")');
eq(parseExpense('платил usdt за хостинг 12'), { description: 'платил за хостинг', amount: 12, currency: 'USDT' }, 'token in the middle');
eq(parseExpense('тест USDT 10'), { description: 'тест', amount: 10, currency: 'USDT' }, 'USDT uppercase');
eq(parseExpense('тест Руб 100'), { description: 'тест', amount: 100, currency: 'RUB' }, '"Руб" capitalized');
eq(parseExpense('рубероид на крышу 1500'), { description: 'рубероид на крышу', amount: 1500, currency: null }, '"рубероид" не матчит руб');
eq(parseExpense('купил рубашку 800'), { description: 'купил рубашку', amount: 800, currency: null }, '"рубашку" не матчит руб');
eq(parseExpense('обмен usdt в rub 100'), { description: 'обмен usdt в rub', amount: 100, currency: null }, 'два токена → ambiguous, currency=null');

console.log('\n=== bangkokContext / bangkokDateOf ===');
const ctx29 = bangkokContext('2026-04-29T08:00:00Z'); // 15:00 in Bangkok same day
eq(ctx29.sectionHeader, '## 29.04.2026, ср', 'section header 29.04.2026 = ср');
eq(ctx29.monthEn, 'april', 'monthEn april');
const ctxLateNight = bangkokContext('2026-04-30T17:30:00Z'); // 00:30 May 1 in Bangkok
eq(ctxLateNight.day, 1, 'late UTC night flips to next day in Bangkok');
eq(ctxLateNight.monthEn, 'may', 'late UTC night flips to may');
eq(bangkokDateOf('2026-05-08T09:52:50.378Z'), '2026-05-08', 'UTC morning → same Bangkok day');
eq(bangkokDateOf('2026-04-30T17:30:00Z'), '2026-05-01', 'UTC night → next Bangkok day');
eq(bangkokDateOf('2026-05-08T12:00:00+07:00'), '2026-05-08', 'noon Bangkok offset → same day');

console.log('\n=== rowToEvent / eventToRow (round-trip) ===');
const ev1 = { id: 'ev_abc', type: 'expense', from: 'cash', to: null, amount: 350, amount_to: null, note: 'кофе', at: '2026-05-08T12:00:00+07:00', client_id: null };
eq(eventToRow(ev1), ['ev_abc', 'expense', 'cash', '', 350, '', 'кофе', '2026-05-08T12:00:00+07:00', ''], 'event → row (nulls become "")');
eq(rowToEvent(eventToRow(ev1)), ev1, 'row → event round-trips');
const ev2 = { id: 'ev_x', type: 'exchange', from: 'bybit', to: 'cash', amount: 300, amount_to: 9400, note: null, at: '2026-05-08T09:52:50.378Z', client_id: 'c_123' };
eq(rowToEvent(eventToRow(ev2)), ev2, 'exchange with client_id round-trips');
// Sheets may return numeric cells as numbers and omit trailing empties — emulate that
eq(rowToEvent(['ev_y', 'income', '', 'bybit', 2499, '', 'ЗП', '2026-05-06T12:00:00+07:00']),
   { id: 'ev_y', type: 'income', from: null, to: 'bybit', amount: 2499, amount_to: null, note: 'ЗП', at: '2026-05-06T12:00:00+07:00', client_id: null },
   'short row (trailing empties omitted) parses with nulls');

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

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
