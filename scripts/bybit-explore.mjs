#!/usr/bin/env node
// Разведка bybit API: проверяет, что read-only ключ рабочий, и печатает балансы
// кошелька + последние операции (депозиты/выводы/обмены), чтобы построить
// маппинг bybit → счёт трекера. Только чтение. Ключи из .env, в stdout не попадают.
//
//   node scripts/bybit-explore.mjs
//
// V5 auth (GET): sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + queryString).

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://api.bybit.com';
const RECV = '5000';

function env(key) {
  let raw;
  try { raw = readFileSync(join(ROOT, '.env'), 'utf8'); }
  catch { exit('.env не найден'); }
  for (const line of raw.split('\n')) {
    if (line.startsWith(key + '=')) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  exit(`${key} не найден в .env`);
}
function exit(msg) { console.error(msg); process.exit(1); }

const API_KEY = env('BYBIT_API_KEY');
const API_SECRET = env('BYBIT_API_KEY_SECRET');

async function get(path, query = '') {
  const ts = Date.now().toString();
  const sign = createHmac('sha256', API_SECRET).update(ts + API_KEY + RECV + query).digest('hex');
  const url = BASE + path + (query ? `?${query}` : '');
  const res = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': RECV,
      'X-BAPI-SIGN': sign,
    },
  });
  const data = await res.json();
  if (data.retCode !== 0) exit(`bybit ${path} retCode=${data.retCode}: ${data.retMsg}`);
  return data.result;
}

const fmt = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(Number(n));

// 1) Балансы кошелька (UNIFIED-аккаунт).
const wallet = await get('/v5/account/wallet-balance', 'accountType=UNIFIED');
console.log('\n=== БАЛАНСЫ (UNIFIED) ===');
for (const acc of wallet.list || []) {
  console.log(`totalEquity≈${fmt(acc.totalEquity)} USD`);
  for (const c of (acc.coin || []).filter((c) => Number(c.walletBalance) !== 0)) {
    console.log(`  ${c.coin.padEnd(6)} ${fmt(c.walletBalance).padStart(16)}  (usdValue≈${fmt(c.usdValue)})`);
  }
}

// 2) Последние выводы (кэшаут в фиат/на кошельки — это уход USDT с bybit).
try {
  const wd = await get('/v5/asset/withdraw/query-record', 'limit=20');
  console.log('\n=== ВЫВОДЫ (последние) ===');
  for (const w of (wd.rows || []).slice(0, 15)) {
    console.log(`  ${new Date(Number(w.createTime)).toISOString().slice(0, 16)}  −${fmt(w.amount)} ${w.coin}  ${w.chain || ''}  status=${w.status}`);
  }
  if (!(wd.rows || []).length) console.log('  (пусто)');
} catch (e) { console.log('\n(выводы недоступны:', e.message, ')'); }

// 3) Последние депозиты.
try {
  const dp = await get('/v5/asset/deposit/query-record', 'limit=20');
  console.log('\n=== ДЕПОЗИТЫ (последние) ===');
  for (const d of (dp.rows || []).slice(0, 15)) {
    console.log(`  ${new Date(Number(d.successAt || d.createTime)).toISOString().slice(0, 16)}  +${fmt(d.amount)} ${d.coin}  ${d.chain || ''}`);
  }
  if (!(dp.rows || []).length) console.log('  (пусто)');
} catch (e) { console.log('\n(депозиты недоступны:', e.message, ')'); }

console.log('');
