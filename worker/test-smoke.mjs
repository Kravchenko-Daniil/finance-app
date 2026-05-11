import { readFileSync } from 'node:fs';

// inline copies of pure logic from src/index.js (no fetch dependencies)
const WEEKDAYS_RU = ['вс','пн','вт','ср','чт','пт','сб'];
const MONTHS_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MONTHS_RU = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

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
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year, month, day, weekdayRu,
    monthEn: MONTHS_EN[month-1], monthRu: MONTHS_RU[month-1],
    filename: `daily-expenses-${MONTHS_EN[month-1]}-${year}.md`,
    sectionHeader: `## ${pad(day)}.${pad(month)}.${year}, ${weekdayRu}`,
    monthHeader: `## Дневник расходов — ${MONTHS_RU[month-1].charAt(0).toUpperCase()+MONTHS_RU[month-1].slice(1)} ${year}`,
  };
}

const fmtAmount = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const escapePipe = (s) => s.replace(/\|/g, '\\|');

function insertExpense(content, ctx, parsed) {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex(l => l.trim() === ctx.sectionHeader);
  if (headerIdx === -1) {
    const block = ['', ctx.sectionHeader, '', '| Что | Бат |', '|---|---:|',
      `| ${escapePipe(parsed.description)} | ${fmtAmount(parsed.amount)} |`,
      `| **Итого** | **${fmtAmount(parsed.amount)}** |`, '', '---', ''].join('\n');
    return content.replace(/\s+$/, '') + '\n' + block;
  }
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^## \d{2}\.\d{2}\.\d{4}/.test(lines[i])) { endIdx = i; break; }
  }
  let itogoIdx = -1;
  for (let i = headerIdx + 1; i < endIdx; i++) {
    if (/^\|\s*\*\*Итого\*\*/.test(lines[i])) { itogoIdx = i; break; }
  }
  if (itogoIdx === -1) {
    let insertAt = endIdx;
    while (insertAt > headerIdx + 1 && (lines[insertAt-1].trim() === '---' || lines[insertAt-1].trim() === '')) insertAt--;
    const block = ['', '| Что | Бат |', '|---|---:|',
      `| ${escapePipe(parsed.description)} | ${fmtAmount(parsed.amount)} |`,
      `| **Итого** | **${fmtAmount(parsed.amount)}** |`, ''];
    lines.splice(insertAt, 0, ...block);
    return lines.join('\n');
  }
  const m = lines[itogoIdx].match(/^\|\s*\*\*Итого\*\*\s*\|\s*\*\*([\d\s ]+)\*\*\s*\|\s*$/);
  const currentTotal = m ? parseInt(m[1].replace(/[\s ]/g, ''), 10) : 0;
  const newTotal = currentTotal + parsed.amount;
  const newRow = `| ${escapePipe(parsed.description)} | ${fmtAmount(parsed.amount)} |`;
  const newItogo = `| **Итого** | **${fmtAmount(newTotal)}** |`;
  lines.splice(itogoIdx, 1, newRow, newItogo);
  return lines.join('\n');
}

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
eq(parseExpense('Ресторан Мишлен на 2 530'), { description: 'Ресторан Мишлен на 2', amount: 530, currency: null }, '"Ресторан Мишлен на 2 530" (last number wins → 530, "на 2" stays in desc)');
eq(parseExpense('массаж 1300'), { description: 'массаж', amount: 1300, currency: null }, '"массаж 1300" (no space)');
eq(parseExpense('  кофе   350  '), { description: 'кофе', amount: 350, currency: null }, 'trim+collapse spaces');
eq(parseExpense('фитнес-зал на месяц 1800'), { description: 'фитнес-зал на месяц', amount: 1800, currency: null }, 'multi-word desc');
try { parseExpense(''); console.log('  ✗ empty should throw'); fail++; } catch { console.log('  ✓ empty throws'); pass++; }
try { parseExpense('кофе'); console.log('  ✗ no number should throw'); fail++; } catch { console.log('  ✓ "кофе" (no amount) throws'); pass++; }

// Currency hint: token after number
eq(parseExpense('перевод другу 26 usdt'), { description: 'перевод другу', amount: 26, currency: 'USDT' }, '"... 26 usdt" → USDT');
eq(parseExpense('подписка 500 руб'), { description: 'подписка', amount: 500, currency: 'RUB' }, '"... 500 руб" → RUB');
eq(parseExpense('steam 15 rub'), { description: 'steam', amount: 15, currency: 'RUB' }, '"... 15 rub" → RUB (latin)');

// Currency hint: token before number
eq(parseExpense('usdt 26'), { description: '—', amount: 26, currency: 'USDT' }, '"usdt 26" (token first, no desc → "—")');
eq(parseExpense('платил usdt за хостинг 12'), { description: 'платил за хостинг', amount: 12, currency: 'USDT' }, 'token in the middle');

// Case-insensitive
eq(parseExpense('тест USDT 10'), { description: 'тест', amount: 10, currency: 'USDT' }, 'USDT uppercase');
eq(parseExpense('тест Руб 100'), { description: 'тест', amount: 100, currency: 'RUB' }, '"Руб" capitalized');

// Word boundary — false-positive guard
eq(parseExpense('рубероид на крышу 1500'), { description: 'рубероид на крышу', amount: 1500, currency: null }, '"рубероид" не матчит \\bруб\\b');
eq(parseExpense('купил рубашку 800'), { description: 'купил рубашку', amount: 800, currency: null }, '"рубашку" не матчит \\bруб\\b');

// Multiple tokens — ambiguous, ignore
eq(parseExpense('обмен usdt в rub 100'), { description: 'обмен usdt в rub', amount: 100, currency: null }, 'два токена → ambiguous, currency=null');

console.log('\n=== bangkokContext ===');
const ctx29 = bangkokContext('2026-04-29T08:00:00Z'); // 15:00 in Bangkok same day
eq(ctx29.filename, 'daily-expenses-april-2026.md', 'filename for april');
eq(ctx29.sectionHeader, '## 29.04.2026, ср', 'section header 29.04.2026 = ср');
const ctxMay = bangkokContext('2026-05-15T05:00:00Z');
eq(ctxMay.filename, 'daily-expenses-may-2026.md', 'filename for may');
eq(ctxMay.monthRu, 'май', 'monthRu for may');
const ctxLateNight = bangkokContext('2026-04-30T17:30:00Z'); // 00:30 May 1 in Bangkok
eq(ctxLateNight.day, 1, 'late UTC night flips to next day in Bangkok');
eq(ctxLateNight.filename, 'daily-expenses-may-2026.md', 'late UTC night flips to may');

// Integration tests against a real archived markdown file.
// Numbers in assertions (e.g. "Итого 2 066 → 2 316") are tied to a specific file —
// these tests are user-local. Set ARCHIVE_MD_PATH to enable; otherwise they're skipped.
const ARCHIVE_MD_PATH = process.env.ARCHIVE_MD_PATH;
let realFile = null;
if (ARCHIVE_MD_PATH) {
  try { realFile = readFileSync(ARCHIVE_MD_PATH, 'utf-8'); }
  catch (e) { console.log(`\n⚠ ARCHIVE_MD_PATH set but file unreadable: ${e.message}`); }
}

if (realFile) {
  console.log('\n=== insertExpense (against real file) ===');
  const ctx28 = bangkokContext('2026-04-28T10:00:00Z');
  const after28 = insertExpense(realFile, ctx28, { description: 'тест-кофе', amount: 250 });
  const lines28 = after28.split('\n');
  const idx28 = lines28.findIndex(l => l.includes('## 28.04.2026'));
  const slice28 = lines28.slice(idx28, idx28 + 15).join('\n');
  console.log('--- section 28.04 after insert (тест-кофе 250):');
  console.log(slice28);
  const newRowOk = slice28.includes('| тест-кофе | 250 |');
  const newItogoOk = slice28.includes('| **Итого** | **2 316** |'); // was 2066, +250 = 2316
  console.log(`  ${newRowOk ? '✓' : '✗'} new row inserted`);
  console.log(`  ${newItogoOk ? '✓' : '✗'} Итого updated 2066 → 2316`);
  if (newRowOk) pass++; else fail++;
  if (newItogoOk) pass++; else fail++;

  const ctx29b = bangkokContext('2026-04-29T08:00:00Z');
  const after29 = insertExpense(realFile, ctx29b, { description: 'манго', amount: 50 });
  const has29 = after29.includes('## 29.04.2026, ср') && after29.includes('| манго | 50 |');
  console.log(`  ${has29 ? '✓' : '✗'} new section 29.04 created with row`);
  if (has29) pass++; else fail++;

  const ctx28c = bangkokContext('2026-04-28T10:00:00Z');
  const after28c = insertExpense(realFile, ctx28c, { description: 'тест-крупная', amount: 5000 });
  const has5k = after28c.includes('| тест-крупная | 5 000 |');
  console.log(`  ${has5k ? '✓' : '✗'} thousand-space format for 5000 → "5 000"`);
  if (has5k) pass++; else fail++;
} else {
  console.log('\n=== insertExpense — skipped (set ARCHIVE_MD_PATH to a real markdown to enable) ===');
}

// === parseDay ===

function parseDay(content, sectionHeader) {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim() === sectionHeader);
  if (headerIdx === -1) return [];
  const expenses = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^## \d{2}\.\d{2}\.\d{4}/.test(trimmed)) break;
    if (trimmed === '---' && expenses.length > 0) break;
    if (!trimmed.startsWith('|')) continue;
    if (/^\|\s*Что\s*\|/i.test(trimmed)) continue;
    if (/^\|---/.test(trimmed)) continue;
    if (/^\|\s*\*\*Итого/.test(trimmed)) continue;
    const safe = trimmed.replace(/\\\|/g, '');
    const m = safe.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (!m) continue;
    const desc = m[1].replace(//g, '|').trim();
    const amountStr = m[2].replace(/\s+/g, '').replace(/\*+/g, '').trim();
    const amount = parseInt(amountStr, 10);
    if (!isFinite(amount) || amount <= 0) continue;
    expenses.push({ description: desc, amount });
  }
  return expenses;
}

if (realFile) {
  console.log('\n=== parseDay (against real april file) ===');
  const day28 = parseDay(realFile, '## 28.04.2026, вт');
  const has28Massage = day28.some((e) => e.description === 'Массаж' && e.amount === 900);
  const has28Voda = day28.some((e) => e.description === 'Вода' && e.amount === 11);
  const has28Bensine = day28.some((e) => e.description === 'Бензин' && e.amount === 250);
  const noItogo28 = !day28.some((e) => /Итого/i.test(e.description));
  const total28 = day28.reduce((s, e) => s + e.amount, 0);
  console.log(`  ${has28Massage ? '✓' : '✗'} 28.04 has Массаж 900`);
  console.log(`  ${has28Voda ? '✓' : '✗'} 28.04 has Вода 11`);
  console.log(`  ${has28Bensine ? '✓' : '✗'} 28.04 has Бензин 250`);
  console.log(`  ${noItogo28 ? '✓' : '✗'} 28.04 excludes Итого row`);
  console.log(`  ${total28 === 2066 ? '✓' : '✗'} 28.04 total = 2066 (got ${total28})`);
  [has28Massage, has28Voda, has28Bensine, noItogo28, total28 === 2066].forEach(b => b ? pass++ : fail++);

  const dayMissing = parseDay(realFile, '## 31.04.2026, чт');
  eq(dayMissing.length, 0, 'missing day → empty');
} else {
  console.log('\n=== parseDay against real file — skipped (set ARCHIVE_MD_PATH to enable) ===');
}

// Synthetic test: amount with thousand-space and escaped pipe
const synth = `
## 01.05.2026, пт

| Что | Бат |
|---|---:|
| фитнес-зал на месяц | 1 800 |
| описание с \\| трубой | 50 |
| **Итого** | **1 850** |

---
`;
const daySynth = parseDay(synth, '## 01.05.2026, пт');
eq(daySynth.length, 2, 'synth day has 2 rows');
eq(daySynth[0], { description: 'фитнес-зал на месяц', amount: 1800 }, '1 800 → 1800');
eq(daySynth[1], { description: 'описание с | трубой', amount: 50 }, 'escaped pipe restored');

// === EVENTS (pure logic copies) ===

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
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'string') return { ok: false, message: 'at must be ISO string' };
    const d = new Date(body.at);
    if (isNaN(d.getTime())) return { ok: false, message: 'at is not valid date' };
    if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return { ok: false, message: 'at cannot be in the future' };
  }
  return { ok: true };
}

function findAccount(b, id) { const a = b.accounts.find(x => x.id === id); if (!a) throw new Error(`unknown: ${id}`); return a; }
function roundCents(b) { for (const a of b.accounts) a.amount = Math.round(a.amount * 100) / 100; return b; }
function applyMutation(b, ev) {
  if (ev.type === 'income') findAccount(b, ev.to).amount += ev.amount;
  else if (ev.type === 'expense') findAccount(b, ev.from).amount -= ev.amount;
  else if (ev.type === 'transfer') {
    const f = findAccount(b, ev.from), t = findAccount(b, ev.to);
    if (f.currency !== t.currency) throw new Error('transfer requires same currency');
    f.amount -= ev.amount; t.amount += ev.amount;
  } else if (ev.type === 'exchange') {
    findAccount(b, ev.from).amount -= ev.amount;
    findAccount(b, ev.to).amount += ev.amount_to;
  }
  return roundCents(b);
}
function reverseMutation(b, ev) {
  if (ev.type === 'income') findAccount(b, ev.to).amount -= ev.amount;
  else if (ev.type === 'expense') findAccount(b, ev.from).amount += ev.amount;
  else if (ev.type === 'transfer') { findAccount(b, ev.from).amount += ev.amount; findAccount(b, ev.to).amount -= ev.amount; }
  else if (ev.type === 'exchange') { findAccount(b, ev.from).amount += ev.amount; findAccount(b, ev.to).amount -= ev.amount_to; }
  return roundCents(b);
}

const sampleBalances = () => ({
  accounts: [
    { id: 'cash', name: 'Налом', amount: 5000, currency: 'THB' },
    { id: 'bybit', name: 'Bybit', amount: 1000, currency: 'USDT' },
    { id: 'maxswap', name: 'maxswap', amount: 50, currency: 'USDT' },
    { id: 'card_t', name: 'Карта Т', amount: 5000, currency: 'RUB' },
  ],
});

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

console.log('\n=== applyMutation / reverseMutation ===');
let b = sampleBalances();
applyMutation(b, { type: 'income', to: 'bybit', amount: 2499 });
eq(b.accounts.find(a => a.id === 'bybit').amount, 3499, 'income +2499 → bybit');

b = sampleBalances();
applyMutation(b, { type: 'transfer', from: 'bybit', to: 'maxswap', amount: 600 });
eq(b.accounts.find(a => a.id === 'bybit').amount, 400, 'transfer bybit -600');
eq(b.accounts.find(a => a.id === 'maxswap').amount, 650, 'transfer maxswap +600');

b = sampleBalances();
applyMutation(b, { type: 'exchange', from: 'bybit', to: 'cash', amount: 200, amount_to: 6200 });
eq(b.accounts.find(a => a.id === 'bybit').amount, 800, 'exchange bybit -200');
eq(b.accounts.find(a => a.id === 'cash').amount, 11200, 'exchange cash +6200');

// expense
b = sampleBalances();
applyMutation(b, { type: 'expense', from: 'bybit', amount: 600 });
eq(b.accounts.find(a => a.id === 'bybit').amount, 400, 'expense bybit -600');

b = sampleBalances();
const evE = { type: 'expense', from: 'bybit', amount: 600 };
applyMutation(b, evE);
reverseMutation(b, evE);
eq(b.accounts.find(a => a.id === 'bybit').amount, 1000, 'reverse expense returns to original');

// reverse
b = sampleBalances();
const ev = { type: 'income', to: 'bybit', amount: 2499 };
applyMutation(b, ev);
reverseMutation(b, ev);
eq(b.accounts.find(a => a.id === 'bybit').amount, 1000, 'reverse income returns to original');

b = sampleBalances();
const ev2 = { type: 'exchange', from: 'bybit', to: 'cash', amount: 200, amount_to: 6200 };
applyMutation(b, ev2);
reverseMutation(b, ev2);
eq(b.accounts.find(a => a.id === 'bybit').amount, 1000, 'reverse exchange bybit');
eq(b.accounts.find(a => a.id === 'cash').amount, 5000, 'reverse exchange cash');

// transfer wrong currency
b = sampleBalances();
try {
  applyMutation(b, { type: 'transfer', from: 'bybit', to: 'cash', amount: 100 });
  console.log('  ✗ transfer different currency should throw'); fail++;
} catch { console.log('  ✓ transfer different currency throws'); pass++; }

// unknown account
b = sampleBalances();
try {
  applyMutation(b, { type: 'income', to: 'wat', amount: 10 });
  console.log('  ✗ unknown account should throw'); fail++;
} catch { console.log('  ✓ unknown account throws'); pass++; }

// rounding (no float drift)
b = sampleBalances();
for (let i = 0; i < 10; i++) applyMutation(b, { type: 'income', to: 'bybit', amount: 0.1 });
eq(b.accounts.find(a => a.id === 'bybit').amount, 1001, 'no float drift after 10×0.1');

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
