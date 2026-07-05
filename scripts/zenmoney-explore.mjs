#!/usr/bin/env node
// Разведка ZenMoney API: дёргает POST /v8/diff и печатает счета + примеры
// операций, чтобы построить маппинг ZenMoney → счета трекера. Только чтение,
// ничего никуда не пишет. Токен читается из .env (строка ZENMONEY_API_KEY=...),
// в stdout сам токен не попадает.
//
//   node scripts/zenmoney-explore.mjs
//
// Токен получить в 1 клик: https://zerro.app/token (open-source клиент ZenMoney).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API = 'https://api.zenmoney.ru/v8/diff/';

function token() {
  let raw;
  try { raw = readFileSync(join(ROOT, '.env'), 'utf8'); }
  catch { exit('.env не найден в корне репо'); }
  for (const line of raw.split('\n')) {
    if (line.startsWith('ZENMONEY_API_KEY')) {
      return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    }
  }
  exit('ZENMONEY_API_KEY не найден в .env (положи строкой ZENMONEY_API_KEY=...)');
}

function exit(msg) { console.error(msg); process.exit(1); }

async function diff(tok) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentClientTimestamp: Math.floor(Date.now() / 1000), serverTimestamp: 0 }),
  });
  if (!res.ok) exit(`ZenMoney /v8/diff ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function fmt(n) {
  if (n == null) return '';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

const data = await diff(token());

// instrument.id → буквенный код валюты (RUB/USD/...)
const instr = {};
for (const i of data.instrument || []) instr[i.id] = i.shortTitle || i.symbol || String(i.id);
// company.id → название банка
const company = {};
for (const c of data.company || []) company[c.id] = c.title || c.fullTitle || String(c.id);

const accounts = (data.account || []).filter((a) => !a.archive);
console.log(`\nserverTimestamp: ${data.serverTimestamp}`);
console.log(`Счета (не архивные): ${accounts.length} из ${(data.account || []).length}\n`);
console.log('  TYPE       BALANCE          CUR  BANK            TITLE                      ZENMONEY_ID');
console.log('  ' + '-'.repeat(110));
for (const a of accounts) {
  // type: cash | ccard | checking | loan | deposit | debt | emoney
  const bal = a.balance != null ? a.balance : a.startBalance;
  const credit = a.creditLimit ? `  creditLimit=${fmt(a.creditLimit)}` : '';
  const bank = (company[a.company] || (a.company == null ? '—' : String(a.company))).slice(0, 14);
  console.log(
    `  ${(a.type || '').padEnd(9)} ${fmt(bal).padStart(14)}  ${(instr[a.instrument] || '?').padEnd(4)} ${bank.padEnd(15)} ${(a.title || '').slice(0, 26).padEnd(27)} ${a.id}${credit}`,
  );
}

// Сводка по типам — чтобы сразу видеть кредиты/кредитки.
const byType = {};
for (const a of accounts) byType[a.type] = (byType[a.type] || 0) + 1;
console.log('\nТипы счетов:', JSON.stringify(byType));

// Последние операции (для понимания формата: income/outcome + accounts = transfer).
const tx = (data.transaction || []).filter((t) => !t.deleted);
tx.sort((a, b) => String(b.date).localeCompare(String(a.date)));
console.log(`\nВсего операций: ${tx.length}. Последние 15:\n`);
const accTitle = {};
for (const a of accounts) accTitle[a.id] = a.title;
for (const t of tx.slice(0, 15)) {
  const out = t.outcome ? `−${fmt(t.outcome)} ${instr[t.outcomeInstrument] || ''} (${accTitle[t.outcomeAccount] || t.outcomeAccount})` : '';
  const inc = t.income ? `+${fmt(t.income)} ${instr[t.incomeInstrument] || ''} (${accTitle[t.incomeAccount] || t.incomeAccount})` : '';
  const kind = t.income && t.outcome ? 'TRANSFER' : t.income ? 'INCOME  ' : 'EXPENSE ';
  console.log(`  ${t.date}  ${kind}  ${out} ${inc}  ${t.comment || t.payee || ''}`.trimEnd());
}
console.log('');
