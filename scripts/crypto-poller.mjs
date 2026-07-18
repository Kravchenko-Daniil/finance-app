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
// Кроме снимка поллер читает крипто-ОПЕРАЦИИ (TRC20-переводы trustwallet + депозиты/
// выводы bybit) и пишет их в лог finance-API как log_only-события (баланс НЕ трогают —
// его ведёт снимок; обычное событие вычло бы сумму второй раз = двойной счёт). Дедуп по
// client_id на стороне API защищает от повтора.
//
// Режимы:
//   --dry-run   снять оба баланса + собрать ВСЕ операции обоих счетов (полная история)
//               и НАПЕЧАТАТЬ их + сводку. НИ ОДНОГО POST (ни snapshot, ни event).
//   --backfill / --full  писать операции с START_DATE (или --since=YYYY-MM-DD) + снимок
//   --events-only        только операции, снимок баланса пропустить
//   --since=YYYY-MM-DD    нижняя граница операций для backfill
//   (без флагов) cron-цикл: снимок + новые операции с курсора (state lastOpTs по счёту)
//
// Примеры:
//   node scripts/crypto-poller.mjs --dry-run   # разведка данных: балансы + все операции
//   node scripts/crypto-poller.mjs --backfill  # залить историю операций + снимок
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
const BACKFILL = process.argv.includes('--backfill') || process.argv.includes('--full');
const EVENTS_ONLY = process.argv.includes('--events-only');
const SINCE_ARG = process.argv.find((a) => a.startsWith('--since='));
const SINCE_DATE = SINCE_ARG ? SINCE_ARG.slice('--since='.length) : null;

// Пол истории операций для backfill (переопределяется --since=YYYY-MM-DD). Снимок
// баланса date-floor игнорирует (он всегда «сейчас»).
const START_DATE = '2026-06-01';

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

// --- Состояние: лог последнего снимка + курсор операций (lastOpTs по счёту, макс.
// обработанный ms epoch). Курсор двигается покурсорно по счёту, не дальше упавшей op. ---
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastSnapshot: null, lastOpTs: {} }; }
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

// --- Операции: TRC20-переводы trustwallet (Trongrid) ---
// Читает USDT-переводы по адресу через /v1/accounts/<addr>/transactions/trc20 с полной
// пагинацией по meta.fingerprint. Направление по совпадению base58-адреса: to===наш →
// income, from===наш → expense. Возвращает нормализованные операции (log_only на записи).
async function fetchTrustwalletTxs(sinceMs) {
  const addr = env('TRUSTWALLET_ADDRESS_USDT_TRON');
  const ops = [];
  let fingerprint = '';
  for (let page = 0; page < 500; page++) {
    let q = `limit=200&contract_address=${USDT_TRC20_CONTRACT}&only_confirmed=true` +
      `&order_by=block_timestamp,asc&min_timestamp=${sinceMs}`;
    if (fingerprint) q += `&fingerprint=${encodeURIComponent(fingerprint)}`;
    const data = await trongridGet(`/v1/accounts/${addr}/transactions/trc20?${q}`);
    const rows = Array.isArray(data && data.data) ? data.data : [];
    for (const tx of rows) {
      const isIn = tx.to === addr;
      const isOut = tx.from === addr;
      if (!isIn && !isOut) continue; // чужой перевод (адрес не совпал) — не наш
      const raw = Number(tx.value);
      if (!Number.isFinite(raw)) continue;
      const amount = round2(raw / USDT_TRC20_DECIMALS);
      // 0-value / микро TRC20-перевод (спам «отравления адреса» на TRON — частое явление):
      // amount≤0 — не движение денег, в лог не пишем вовсе. Иначе validateEvent режет это
      // HTTP 400 (не ретраится) → op вечно ok:false → её ts морозит курсор trustwallet
      // навсегда, каждый прогон растёт молчаливый ре-скан. Пропускаем на нормализации.
      if (!(amount > 0)) continue;
      // Без стабильного непустого transaction_id client_id схлопнется дедупом с чужими —
      // лучше не записать, чем записать со сталкивающимся id. Пропускаем с warn.
      const txid = tx.transaction_id ? String(tx.transaction_id) : '';
      if (!txid) { console.warn('  ⚠ trustwallet TRC20 без transaction_id — пропуск'); continue; }
      const ts = Number(tx.block_timestamp);
      ops.push({
        // client_id ≤64 (validateEvent режет >64 → HTTP 400 → api() бросает, 400 не
        // ретраится). Tron transaction_id = 64 hex → берём срез 60: 'tw_'+60 = 63. Префикс
        // 'tw_' уникален для trustwallet, чтобы перевод tw→bybit с ОДНИМ хэшем не схлопнулся
        // дедупом с bybit-депозитом (bd_) — это две легитимные строки.
        client_id: `tw_${txid.slice(0, 60)}`,
        type: isIn ? 'income' : 'expense',
        account: 'trustwallet',
        amount,
        at: new Date(ts).toISOString(),
        ts,
        note: isIn ? 'TRC20 in' : 'TRC20 out',
      });
    }
    fingerprint = (data && data.meta && data.meta.fingerprint) || '';
    if (!fingerprint || !rows.length) break;
  }
  return ops;
}

// --- Операции: депозиты и выводы bybit (V5, HMAC) ---
// Депозит = приток (income), вывод = отток (expense). Только coin==='USDT' и время
// (successAt||createTime для депо, createTime для вывода) >= sinceMs. Полная пагинация по
// result.nextPageCursor. client_id с префиксом, чтобы депо и вывод не столкнулись.
async function fetchBybitOps(sinceMs) {
  const ops = [];

  let cursor = '';
  for (let page = 0; page < 500; page++) {
    const q = 'limit=50' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const result = await bybitGet('/v5/asset/deposit/query-record', q);
    const rows = (result && result.rows) || [];
    for (const d of rows) {
      if (d.coin !== 'USDT') continue;
      const ts = Number(d.successAt || d.createTime);
      const amt = Number(d.amount);
      if (!Number.isFinite(ts) || ts < sinceMs || !Number.isFinite(amt)) continue;
      const amount = round2(amt);
      if (!(amount > 0)) continue; // 0-value — не движение денег, в лог не пишем
      // Без стабильного непустого id (txID||id) client_id стал бы 'bd_' / 'bd_undefined' и
      // разные депозиты схлопнулись бы дедупом — лучше пропустить с warn.
      const id = (d.txID || d.id) ? String(d.txID || d.id) : '';
      if (!id) { console.warn('  ⚠ bybit deposit без txID/id — пропуск'); continue; }
      ops.push({
        // 'bd_'+txID(64 hex).slice(0,60) = 63 ≤64. Префикс bd_ ≠ tw_ ≠ bw_ → нет коллизии
        // при переводе tw→bybit с общим on-chain хэшем.
        client_id: `bd_${id.slice(0, 60)}`,
        type: 'income', account: 'bybit',
        amount, at: new Date(ts).toISOString(), ts, note: 'bybit deposit',
      });
    }
    cursor = (result && result.nextPageCursor) || '';
    if (!cursor || !rows.length) break;
  }

  cursor = '';
  for (let page = 0; page < 500; page++) {
    const q = 'limit=50' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const result = await bybitGet('/v5/asset/withdraw/query-record', q);
    const rows = (result && result.rows) || [];
    for (const w of rows) {
      if (w.coin !== 'USDT') continue;
      const ts = Number(w.createTime);
      const amt = Number(w.amount);
      if (!Number.isFinite(ts) || ts < sinceMs || !Number.isFinite(amt)) continue;
      const amount = round2(amt);
      if (!(amount > 0)) continue; // 0-value — не движение денег, в лог не пишем
      // Без стабильного непустого id (txID||withdrawId) client_id столкнулся бы у разных
      // выводов — лучше пропустить с warn.
      const id = (w.txID || w.withdrawId) ? String(w.txID || w.withdrawId) : '';
      if (!id) { console.warn('  ⚠ bybit withdraw без txID/withdrawId — пропуск'); continue; }
      ops.push({
        // 'bw_'+txID(64 hex).slice(0,60) = 63 ≤64. Префикс bw_ ≠ bd_ → вывод и депозит с
        // одинаковым хэшем не столкнутся.
        client_id: `bw_${id.slice(0, 60)}`,
        type: 'expense', account: 'bybit',
        amount, at: new Date(ts).toISOString(), ts, note: 'bybit withdraw',
      });
    }
    cursor = (result && result.nextPageCursor) || '';
    if (!cursor || !rows.length) break;
  }

  return ops;
}

// Запись операций в лог: каждое — log_only:true (баланс ведёт снимок). Направление кодирует
// ТИП (income→to, expense→from), amount всегда положительный. sleep(250) между POST —
// каждый /event сканирует весь лог (дедуп по client_id). Учитываем res.deduped.
async function writeOps(ops) {
  let nEv = 0, nDedup = 0, nErr = 0;
  // results: по операции — { account, ts, ok } (ok = записана ИЛИ дедупнута). Нужно для
  // покурсорного продвижения: курсор счёта не должен уехать за упавшую операцию.
  const results = [];
  for (const op of ops) {
    const body = op.type === 'income'
      ? { type: 'income', to: op.account, amount: op.amount, note: op.note, at: op.at, client_id: op.client_id, log_only: true }
      : { type: 'expense', from: op.account, amount: op.amount, note: op.note, at: op.at, client_id: op.client_id, log_only: true };
    let ok = false;
    try {
      const res = await api('POST', '/event', body);
      if (res.deduped) nDedup++; else nEv++;
      ok = true;
    } catch (e) {
      nErr++;
      console.error(`  ✗ event ${op.client_id}: ${e.message}`);
    }
    results.push({ account: op.account, ts: op.ts, ok });
    await sleep(250);
  }
  return { nEv, nDedup, nErr, results };
}

// --- Основной цикл ---
async function poll() {
  const mode = DRY ? 'DRY' : BACKFILL ? 'BACKFILL' : EVENTS_ONLY ? 'EVENTS-ONLY' : 'cron';
  console.log(`[crypto ${mode}] снимаю балансы + операции trustwallet + bybit`);

  const state = loadState();
  state.lastOpTs = state.lastOpTs || {};

  // --- Снимок балансов (кроме --events-only) ---
  let balances = null;
  if (!EVENTS_ONLY) {
    const ts = await fetchTrustwallet();
    const by = await fetchBybit();
    balances = [
      { account: 'trustwallet', amount: ts },
      { account: 'bybit', amount: by },
    ];
    console.log(`  trustwallet(USDT)=${ts}  bybit(USDT)=${by}`);
  }

  // --- Снимок балансов шлём ПЕРВЫМ — до фетча операций. Снимок обязан быть независим от
  //     доступности ops-эндпойнтов (Trongrid/bybit): их исчерпание ретраев зовёт die()→
  //     exit(1), и если бы снимок шёл после фетча, он бы терялся. В --dry-run не шлём.
  //     Сбой снимка НЕ прерывает запись операций (они самостоятельны) — помечаем флаг и в
  //     конце выходим кодом !=0, иначе баланс тихо устаревает, а cron/watchdog не замечает.
  let snapshotFailed = false;
  if (!DRY && balances) {
    try {
      await api('POST', '/snapshot', { balances });
      state.lastSnapshot = { at: new Date().toISOString(), balances };
      console.log('  snapshot отправлен');
    } catch (e) {
      snapshotFailed = true;
      console.error(`  ✗ snapshot FAILED — баланс мог устареть, exit≠0: ${e.message}`);
    }
  }

  // --- Нижняя граница операций по счёту ---
  const startMs = Date.parse(`${SINCE_DATE || START_DATE}T00:00:00Z`);
  const sinceFor = (account) => {
    if (DRY) return 0;                       // разведка: вся доступная история
    if (BACKFILL) return startMs;            // backfill: с START_DATE / --since (курсор игнор)
    return state.lastOpTs[account] || startMs; // cron: с сохранённого курсора
  };

  const tronOps = await fetchTrustwalletTxs(sinceFor('trustwallet'));
  const bybitOps = await fetchBybitOps(sinceFor('bybit'));
  const ops = [...tronOps, ...bybitOps].sort((a, b) => a.ts - b.ts); // хронологически

  // --- --dry-run: только печать, НИ ОДНОГО POST ---
  if (DRY) {
    for (const op of ops) {
      console.log(`  ${op.account.padEnd(11)} ${op.type.padEnd(7)} ${String(op.amount).padStart(12)}` +
        `  ${op.at.slice(0, 16)}  ${op.client_id}`);
    }
    const tw = ops.filter((o) => o.account === 'trustwallet');
    const bb = ops.filter((o) => o.account === 'bybit');
    const dates = ops.map((o) => o.at).sort();
    console.log(`\n[crypto DRY] операций: trustwallet=${tw.length}, bybit=${bb.length}, всего=${ops.length}`);
    if (dates.length) console.log(`  диапазон: ${dates[0].slice(0, 10)} … ${dates[dates.length - 1].slice(0, 10)}`);
    console.log('[crypto DRY] НИЧЕГО не отправлено (ни snapshot, ни event)');
    return;
  }

  // --- Операции (log_only) ---
  const { nEv, nDedup, nErr, results } = await writeOps(ops);
  console.log(`  события: new=${nEv} dedup=${nDedup} err=${nErr}`);

  // --- Курсор: покурсорно ПО КАЖДОМУ счёту (не всё-или-ничего). Двигаем до максимального
  // ts успешно записанной/дедупнутой операции счёта, но НЕ дальше самой ранней упавшей
  // операции этого счёта — иначе упавшее уедет за курсор и cron его не переотправит
  // (восстановление — через --backfill, дедуп по client_id защитит уже записанные).
  // Backfill курсор игнорирует. ---
  if (!BACKFILL) {
    for (const acc of ['trustwallet', 'bybit']) {
      const accRes = results.filter((r) => r.account === acc);
      const failedMinTs = accRes
        .filter((r) => !r.ok)
        .reduce((m, r) => Math.min(m, r.ts), Infinity);
      let max = state.lastOpTs[acc] || 0;
      for (const r of accRes) {
        if (r.ok && r.ts < failedMinTs) max = Math.max(max, r.ts);
      }
      state.lastOpTs[acc] = max;
    }
  }
  saveState(state);

  // Снимок упал → ненулевой код выхода (операции всё равно записаны выше).
  if (snapshotFailed) process.exitCode = 1;
}

await poll();
