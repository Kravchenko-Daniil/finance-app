#!/usr/bin/env node
// Крипто cron-поллер: снимает балансы двух крипто-счетов и зеркалит их снимком в
// finance-API (POST /api/snapshot). «Сигнал 1 (снимок)» из aggregator-design.md §2.
//
// Счета и источники (authority = direct — баланс источника точный, БЕЗ anchor/offset;
// снимок SET, не дельта → идемпотентность на стороне сервера):
//   • trustwallet (USDT, TRC20) — публичный Trongrid, ключ не нужен. Баланс = TRC20-запись
//     контракта USDT (TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t) в /v1/accounts/<addr>, raw/1e6.
//   • bybit (USDT, UNIFIED) — приватный V5 API (HMAC), walletBalance монеты USDT.
//
// Оба баланса → ОДИН POST /api/snapshot { balances:[{account,amount}, …] }. Лог Events
// снимок НЕ трогает (не операция). Счета зеркалятся снимком → своих операций не мутируют.
//
// Режимы:
//   --dry-run   получить и напечатать оба баланса, НО НЕ делать POST
//   (без флагов) один цикл: снимок обоих балансов
//
// Примеры:
//   node scripts/crypto-poller.mjs --dry-run   # превью балансов без записи
//   node scripts/crypto-poller.mjs             # боевой цикл (cron)
//
// Креды/токен из .env (в stdout НЕ попадают): TRUSTWALLET_ADDRESS_USDT_TRON,
// BYBIT_API_KEY, BYBIT_API_KEY_SECRET, APP_TOKEN.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = join(ROOT, '.env');
const STATE_DIR = join(ROOT, 'scripts', '.state');
const STATE_FILE = join(STATE_DIR, 'crypto.json');

const API_BASE = 'https://finance.daniilkravchenko.com/api';
const TRONGRID_BASE = 'https://api.trongrid.io';
const BYBIT_BASE = 'https://api.bybit.com';
const BYBIT_RECV = '5000';
// Контракт USDT (Tether) в сети Tron (TRC20). Баланс монеты берём именно по нему.
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_TRC20_DECIMALS = 1e6;

// Браузерный UA обязателен — без него Cloudflare WAF (и перед finance-API, и перед
// Trongrid/bybit) может отдать 403 / error 1010.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DRY = process.argv.includes('--dry-run');

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(key, required = true) {
  let raw;
  try { raw = readFileSync(ENV, 'utf8'); }
  catch { die(`.env не найден: ${ENV}`); }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith(key + '=')) return t.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  if (required) die(`${key} не найден в .env`);
  return null;
}

// --- Состояние (лог последнего снимка; для логики снимка не обязателен) ---
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastSnapshot: null }; }
}
function saveState(state) {
  if (DRY) return;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- finance-API ---
// Каждый /snapshot читает/пишет Sheets → возможны 429/502/503 (квота на минуту).
// Ретраим с экспоненциальным backoff (dependency-free).
async function api(method, path, body, attempt = 0) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${env('APP_TOKEN')}`,
      'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return res.json();
  const text = (await res.text()).slice(0, 200);
  const retriable = (res.status === 429 || res.status === 502 || res.status === 503) && attempt < 5;
  if (retriable) {
    const wait = Math.min(30000, 2000 * 2 ** attempt); // 2s,4s,8s,16s,30s
    console.error(`  · ${res.status} ${path} — retry через ${wait / 1000}s (попытка ${attempt + 1}/5)`);
    await sleep(wait);
    return api(method, path, body, attempt + 1);
  }
  throw new Error(`HTTP ${res.status} ${path}: ${text}`);
}

// --- Trongrid (публичный, ключ не нужен) ---
// Транзиентные сетевые сбои + Cloudflare WAF перед Trongrid → ретраим с backoff.
async function trongridGet(path, attempt = 0) {
  try {
    const res = await fetch(TRONGRID_BASE + path, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if ((res.status === 429 || res.status >= 500) && attempt < 4) throw new Error(`${res.status}: ${text}`);
      die(`Trongrid ${path} ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    if (attempt < 4) {
      const wait = Math.min(30000, 2000 * 2 ** attempt);
      console.error(`  · Trongrid сбой (${e.message?.slice(0, 60)}) — retry через ${wait / 1000}s (${attempt + 1}/4)`);
      await sleep(wait);
      return trongridGet(path, attempt + 1);
    }
    die(`Trongrid ${path}: ${e.message}`);
  }
}

// Баланс TRUSTWALLET (USDT TRC20). Ответ Trongrid: data[0].trc20 — массив объектов
// { "<contract>": "<raw>" }. Ищем запись по контракту USDT, raw / 1e6, round2.
// Пустой ответ / нет TRC20-записи по контракту → 0.
async function fetchTrustwallet() {
  const addr = env('TRUSTWALLET_ADDRESS_USDT_TRON');
  const data = await trongridGet(`/v1/accounts/${addr}`);
  const acc = (data && Array.isArray(data.data)) ? data.data[0] : null;
  if (!acc || !Array.isArray(acc.trc20)) return 0;
  for (const entry of acc.trc20) {
    if (entry && Object.prototype.hasOwnProperty.call(entry, USDT_TRC20_CONTRACT)) {
      const raw = Number(entry[USDT_TRC20_CONTRACT]);
      if (!Number.isFinite(raw)) return 0;
      return round2(raw / USDT_TRC20_DECIMALS);
    }
  }
  return 0;
}

// --- bybit V5 (приватный, HMAC) ---
// sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + queryString).
// Транзиентные сбои / WAF → ретраим по HTTP-статусу с backoff (retCode-ошибки — фатальны).
async function bybitGet(path, query = '', attempt = 0) {
  const apiKey = env('BYBIT_API_KEY');
  const apiSecret = env('BYBIT_API_KEY_SECRET');
  const ts = Date.now().toString();
  const sign = createHmac('sha256', apiSecret).update(ts + apiKey + BYBIT_RECV + query).digest('hex');
  const url = BYBIT_BASE + path + (query ? `?${query}` : '');
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': BYBIT_RECV,
        'X-BAPI-SIGN': sign,
      },
    });
  } catch (e) {
    if (attempt < 4) {
      const wait = Math.min(30000, 2000 * 2 ** attempt);
      console.error(`  · bybit сбой (${e.message?.slice(0, 60)}) — retry через ${wait / 1000}s (${attempt + 1}/4)`);
      await sleep(wait);
      return bybitGet(path, query, attempt + 1);
    }
    die(`bybit ${path}: ${e.message}`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Math.min(30000, 2000 * 2 ** attempt);
      console.error(`  · bybit ${res.status} — retry через ${wait / 1000}s (${attempt + 1}/4)`);
      await sleep(wait);
      return bybitGet(path, query, attempt + 1);
    }
    die(`bybit ${path} ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (data.retCode !== 0) die(`bybit ${path} retCode=${data.retCode}: ${data.retMsg}`);
  return data.result;
}

// Баланс BYBIT (USDT в UNIFIED-аккаунте). Если монеты USDT нет в списке → 0.
async function fetchBybit() {
  const wallet = await bybitGet('/v5/account/wallet-balance', 'accountType=UNIFIED');
  for (const acc of wallet.list || []) {
    for (const c of acc.coin || []) {
      if (c.coin === 'USDT') {
        const bal = Number(c.walletBalance);
        return Number.isFinite(bal) ? round2(bal) : 0;
      }
    }
  }
  return 0;
}

// --- Основной цикл ---
async function poll() {
  console.log(`[crypto${DRY ? ' DRY' : ''}] снимаю балансы trustwallet + bybit`);

  const ts = await fetchTrustwallet();
  const by = await fetchBybit();
  console.log(`  trustwallet(USDT)=${ts}  bybit(USDT)=${by}`);

  const balances = [
    { account: 'trustwallet', amount: ts },
    { account: 'bybit', amount: by },
  ];

  if (DRY) {
    console.log('[crypto DRY] snapshot НЕ отправлен');
    return;
  }

  try {
    await api('POST', '/snapshot', { balances });
    const state = loadState();
    state.lastSnapshot = { at: new Date().toISOString(), balances };
    saveState(state);
    console.log(`[crypto] snapshot отправлен: trustwallet=${ts}, bybit=${by}`);
  } catch (e) {
    console.error(`  ✗ snapshot: ${e.message}`);
    process.exit(1);
  }
}

await poll();
