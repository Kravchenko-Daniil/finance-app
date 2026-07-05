#!/usr/bin/env node
// Сверка ZenMoney: печатает чеклист счетов (баланс из ZenMoney + пустое поле под
// твой реальный баланс из банка) и размер истории с даты START_DATE. Только чтение.
// Токен — из .env (ZENMONEY_API_KEY), в stdout не попадает.
//
//   node scripts/zenmoney-checklist.mjs                 # история с 2026-04-10 (дефолт)
//   START_DATE=2026-01-01 node scripts/zenmoney-checklist.mjs
//
// Цель: пройтись по чеклисту, открыть каждый банк, поставить реальную цифру рядом.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const API = 'https://api.zenmoney.ru/v8/diff/';
const START = process.env.START_DATE || '2026-04-10';

function token() {
  let raw;
  try { raw = readFileSync(join(ROOT, '.env'), 'utf8'); }
  catch { exit('.env не найден в корне репо'); }
  for (const line of raw.split('\n')) {
    if (line.startsWith('ZENMONEY_API_KEY')) {
      return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    }
  }
  exit('ZENMONEY_API_KEY не найден в .env');
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
const instr = {};
for (const i of data.instrument || []) instr[i.id] = i.shortTitle || i.symbol || String(i.id);
const company = {};
for (const c of data.company || []) company[c.id] = c.title || c.fullTitle || String(c.id);

const accounts = (data.account || []).filter((a) => !a.archive);
const accTitle = {};
for (const a of accounts) accTitle[a.id] = a.title;

// Решаем: «keep» (есть ненулевой баланс или кредитный счёт) vs «skip» (пустышка).
function decide(a) {
  const bal = a.balance != null ? a.balance : a.startBalance;
  if (a.type === 'debt' || a.title === 'Наличные') return 'skip'; // служебные ZenMoney
  if ((a.type === 'loan' || a.creditLimit) ) return 'keep';        // кредиты/кредитки — всегда
  if (Math.abs(bal) < 1) return 'skip';                            // ~ноль — пустышка
  return 'keep';
}

const keep = accounts.filter((a) => decide(a) === 'keep');
const skip = accounts.filter((a) => decide(a) === 'skip');

function row(a) {
  const bal = a.balance != null ? a.balance : a.startBalance;
  const credit = a.creditLimit ? ` (лимит ${fmt(a.creditLimit)})` : '';
  const bank = (company[a.company] || '—').slice(0, 12);
  return `  [ ] ${bank.padEnd(13)} ${(a.title || '').slice(0, 26).padEnd(27)} ${(a.type || '').padEnd(9)} ZenMoney: ${fmt(bal).padStart(14)} ${instr[a.instrument] || ''}${credit}\n        ↳ твой реальный баланс: ______________`;
}

console.log(`\n${'='.repeat(78)}`);
console.log('ЧЕКЛИСТ СВЕРКИ — открой каждый банк и впиши реальный баланс рядом');
console.log('='.repeat(78));
console.log(`\n► ЗЕРКАЛИМ В ТРЕКЕР (${keep.length} счетов):\n`);
for (const a of keep) console.log(row(a));
console.log(`\n► ПРОПУСКАЕМ — пустые/служебные (${skip.length}):\n`);
for (const a of skip) {
  const bal = a.balance != null ? a.balance : a.startBalance;
  console.log(`  ✗ ${(company[a.company] || '—').slice(0, 12).padEnd(13)} ${(a.title || '').slice(0, 26).padEnd(27)} = ${fmt(bal)} ${instr[a.instrument] || ''}`);
}

// История с START.
const tx = (data.transaction || []).filter((t) => !t.deleted);
const since = tx.filter((t) => String(t.date) >= START);
const byType = { income: 0, expense: 0, transfer: 0 };
const byMonth = {};
for (const t of since) {
  const k = t.income && t.outcome ? 'transfer' : t.income ? 'income' : 'expense';
  byType[k]++;
  const m = String(t.date).slice(0, 7);
  byMonth[m] = (byMonth[m] || 0) + 1;
}
console.log(`\n${'='.repeat(78)}`);
console.log(`ИСТОРИЯ С ${START}`);
console.log('='.repeat(78));
console.log(`\nВсего операций в ZenMoney: ${tx.length}`);
console.log(`С ${START}: ${since.length}  (income ${byType.income} / expense ${byType.expense} / transfer ${byType.transfer})\n`);
for (const m of Object.keys(byMonth).sort()) console.log(`  ${m}: ${byMonth[m]}`);
console.log('');
