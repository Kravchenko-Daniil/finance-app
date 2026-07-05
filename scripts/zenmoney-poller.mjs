#!/usr/bin/env node
// ZenMoney cron-поллер: тянет /v8/diff по курсору → зеркалит балансы РФ-банков в
// finance-API (snapshot) + пишет операции log_only-событиями (для аналитики/сторожа).
// «Сигнал 1 (снимок) + Сигнал 2 (поток)» из aggregator-design.md §2-§3 для банков РФ.
//
// Модель балансов (authority по §3):
//   • кредиты/вклад (zenmoney-authority) — баланс ZenMoney точный → snapshot напрямую.
//   • дебет (anchor/offset-модель) — баланс ZenMoney врёт на КОНСТАНТУ (кривой якорь
//     коннектора), но дельты операций точны. Фиксируем offset = zen − реал ОДИН раз
//     (--set-anchor), дальше tracker = zen_now − offset. Самоисцеляется, без Σлога.
//
// Все операции пишутся log_only:true — баланс уже ведётся снимком, мутировать его
// событием нельзя (двойной счёт). Дедуп/идемпотентность по client_id = zen_<txId>.
// Курсор (serverTimestamp ZenMoney) + offsets — в scripts/.state/zenmoney.json.
//
// Режимы:
//   --dry-run                       ничего не писать, только печатать план
//   --set-anchor tbank_debit=5650 vtb_debit=0.60
//                                   зафиксировать offset дебета из текущего zen-баланса
//   --events-only                   только операции (log_only), БЕЗ снимка балансов —
//                                   для backfill истории, пока кредит-счета/§9п.1 не готовы
//   --full                          игнорировать курсор (serverTimestamp=0, полный ресинк)
//   (без флагов)                    один цикл: snapshot изменённых балансов + новые операции
//
// Примеры:
//   node scripts/zenmoney-poller.mjs --set-anchor tbank_debit=5650 vtb_debit=0.60
//   node scripts/zenmoney-poller.mjs --dry-run        # превью (первый прогон = backfill)
//   node scripts/zenmoney-poller.mjs                  # боевой цикл (cron)
//
// Креды/токен из .env (в stdout НЕ попадают): ZENMONEY_API_KEY, APP_TOKEN.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = join(ROOT, '.env');
const STATE_DIR = join(ROOT, 'scripts', '.state');
const STATE_FILE = join(STATE_DIR, 'zenmoney.json');

const ZEN_API = 'https://api.zenmoney.ru/v8/diff/';
const API_BASE = 'https://finance.daniilkravchenko.com/api';
// Браузерный UA обязателен — без него Cloudflare WAF отдаёт 403 / error 1010.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Пол истории для backfill: старт трекера 10.04.2026 (решение Даниила, §7/§9п.3).
// Операции раньше — не заливаем. Снимок балансов date-floor игнорирует (он всегда «сейчас»).
const START_DATE = '2026-04-10';

const DRY = process.argv.includes('--dry-run');
const FULL = process.argv.includes('--full');
const EVENTS_ONLY = process.argv.includes('--events-only');

// Маппинг счетов ZenMoney (UUID) → счёт трекера + authority по балансу.
// UUID из живой разведки (scripts/zenmoney-explore.mjs) + aggregator-design.md §12.
// Не перечисленные счета ZenMoney (Совком-фантом, пустые кошельки, Наличные/Долги) — игнор.
const ZEN_ACCOUNTS = {
  '13bebc25-bdd4-46cb-8ffb-cf6b1ee59b29': { tracker: 'tbank_debit',    authority: 'anchor' },   // Т-Банк «Tinkoff»
  '9255e4c0-f255-4a7d-8cb6-2d4203bdafc5': { tracker: 'vtb_debit',      authority: 'anchor' },   // ВТБ «Втб»
  'eca6f7bd-d1cd-4547-a461-700d356bf076': { tracker: 'tbank_platinum', authority: 'zenmoney' }, // Т-Банк «Платинум»
  '0b740475-0b23-41f1-b3bd-535f11b4fe06': { tracker: 'tbank_loan',     authority: 'zenmoney' }, // Т-Банк «Кредит наличными»
  '327a35bd-4bb2-43de-a6ee-714911565469': { tracker: 'vtb_carloan',    authority: 'zenmoney' }, // ВТБ «Автокредит наличными»
  '63f08cfa-db5d-4eaf-82a3-d68270224473': { tracker: 'vtb_deposit',    authority: 'zenmoney' }, // ВТБ «Коплика» (вклад)
  '9d91615b-1cda-4d30-a1be-c6987bf5bd3f': { tracker: 'alfa_credit',    authority: 'zenmoney' }, // Альфа «Счет кредитной карты»
  '652dfd75-ec69-4cf8-8a1e-381da370be51': { tracker: 'mts_loan',       authority: 'zenmoney' }, // МТС «На покупку товара»
};

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

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

// --- Состояние (курсор ZenMoney + offsets дебета) ---
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { serverTimestamp: 0, offsets: {} }; }
}
function saveState(state) {
  if (DRY) return;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- ZenMoney /v8/diff ---
// TLS-хендшейк ZenMoney временами медленный (~10s) и undici срывается по connect-таймауту;
// плюс возможны транзиентные сетевые сбои. Ретраим с backoff (dependency-free).
async function zenDiff(serverTimestamp, attempt = 0) {
  try {
    const res = await fetch(ZEN_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('ZENMONEY_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentClientTimestamp: Math.floor(Date.now() / 1000), serverTimestamp }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if ((res.status === 429 || res.status >= 500) && attempt < 4) throw new Error(`${res.status}: ${text}`);
      die(`ZenMoney /v8/diff ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    if (attempt < 4) {
      const wait = Math.min(20000, 2000 * 2 ** attempt);
      console.error(`  · ZenMoney /v8/diff сбой (${e.message?.slice(0, 60)}) — retry через ${wait / 1000}s (${attempt + 1}/4)`);
      await sleep(wait);
      return zenDiff(serverTimestamp, attempt + 1);
    }
    die(`ZenMoney /v8/diff: ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- finance-API ---
// Каждый /event сканирует весь лог Events для дедупа → читает Sheets много раз.
// Backfill (десятки событий подряд) легко пробивает read-quota Sheets (429 → 502).
// Поэтому ретраим 429/502 с экспоненциальным backoff (квота — на минуту, отпустит).
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

// Транзакция ZenMoney → тело события finance-API (или null, если не касается трекаемого счёта).
// Обе ноги трекаемы → transfer; одна нога → expense (отток) / income (приток) на ней.
// Всё log_only:true (баланс ведётся снимком). client_id = zen_<txId>, at = день+полдень МСК.
function txToEvent(tx) {
  if (tx.deleted) return null;
  const outT = ZEN_ACCOUNTS[tx.outcomeAccount];
  const inT = ZEN_ACCOUNTS[tx.incomeAccount];
  const hasOut = tx.outcome > 0;
  const hasIn = tx.income > 0;
  if (!(hasOut && outT) && !(hasIn && inT)) return null; // ни одна нога не трекается

  // ZenMoney сам создаёт служебную операцию «Автоматическая корректировка баланса счета»,
  // когда баланс счёта правят руками (Даниил так выставил реальные дебеты/кредиты). Эти
  // счета зеркалятся снимком — баланс и так верный, а корректировка как expense/income —
  // мусор в логе аналитики (напр. фиктивный −3.13М на vtb_carloan). Никогда не логируем.
  const rawComment = (tx.comment || tx.payee || '').toLowerCase();
  if (rawComment.includes('корректировка баланс')) return null;

  const cid = `zen_${tx.id}`;
  const at = `${tx.date}T12:00:00+03:00`;
  const note = (tx.comment || tx.payee || '').trim() || null;
  const base = { at, client_id: cid, log_only: true };

  // Перевод между двумя трекаемыми счетами.
  if (hasOut && hasIn && outT && inT) {
    if (round2(tx.outcome) === round2(tx.income)) {
      // одна валюта (все РФ-счета RUB) → transfer
      return { type: 'transfer', from: outT.tracker, to: inT.tracker, amount: round2(tx.outcome), note, ...base };
    }
    // разная сумма ног (конвертация) → exchange
    return { type: 'exchange', from: outT.tracker, to: inT.tracker,
      amount: round2(tx.outcome), amount_to: round2(tx.income), note, ...base };
  }
  // Трекаема только нога оттока → расход (вторая нога — внешний/нетрекаемый счёт).
  if (hasOut && outT) {
    return { type: 'expense', from: outT.tracker, amount: round2(tx.outcome), note, ...base };
  }
  // Трекаема только нога притока → доход.
  return { type: 'income', to: inT.tracker, amount: round2(tx.income), note, ...base };
}

// --- Режим --set-anchor: зафиксировать offset дебета из текущего zen-баланса ---
async function setAnchor() {
  const i = process.argv.indexOf('--set-anchor');
  const pairs = process.argv.slice(i + 1).filter((a) => a.includes('='));
  if (!pairs.length) die('--set-anchor требует пары вида tbank_debit=5650');

  const data = await zenDiff(0); // полный снимок — нужны текущие балансы
  const zenBalByTracker = {};
  for (const a of data.account || []) {
    const m = ZEN_ACCOUNTS[a.id];
    if (m) zenBalByTracker[m.tracker] = a.balance != null ? a.balance : a.startBalance;
  }

  const state = loadState();
  state.offsets = state.offsets || {};
  for (const p of pairs) {
    const [tracker, realStr] = p.split('=');
    const real = Number(realStr);
    if (!Number.isFinite(real)) die(`плохое значение якоря: ${p}`);
    const mapping = Object.values(ZEN_ACCOUNTS).find((m) => m.tracker === tracker);
    if (!mapping || mapping.authority !== 'anchor') die(`${tracker} — не anchor-счёт (anchor только для дебета)`);
    if (!(tracker in zenBalByTracker)) die(`${tracker} не найден в текущем снимке ZenMoney`);
    const zen = zenBalByTracker[tracker];
    const offset = round2(zen - real);
    state.offsets[tracker] = offset;
    console.log(`  anchor ${tracker}: zen=${zen} real=${real} → offset=${offset}`);
  }
  saveState(state);
  console.log(DRY ? '\n[set-anchor DRY] offsets не сохранены' : '\n[set-anchor] offsets сохранены');
}

// --- Основной цикл поллинга ---
async function poll() {
  const state = loadState();
  const cursor = FULL ? 0 : (state.serverTimestamp || 0);
  const backfill = cursor === 0;
  console.log(`[poll${DRY ? ' DRY' : ''}${FULL ? ' FULL' : ''}${EVENTS_ONLY ? ' EVENTS-ONLY' : ''}] serverTimestamp>${cursor}` +
    (backfill ? ` (первый прогон = backfill истории с ${START_DATE})` : ''));

  const data = await zenDiff(cursor);

  // --- Снимок балансов изменённых трекаемых счетов ---
  let nSnap = 0;
  const snapshots = [];
  const warns = [];
  for (const a of (EVENTS_ONLY ? [] : data.account || [])) {
    const m = ZEN_ACCOUNTS[a.id];
    if (!m) continue;
    const zen = a.balance != null ? a.balance : a.startBalance;
    let amount;
    if (m.authority === 'anchor') {
      const offset = state.offsets?.[m.tracker];
      if (offset == null) {
        warns.push(`offset для ${m.tracker} не задан — баланс НЕ зеркалю (нужен --set-anchor ${m.tracker}=<реал>)`);
        continue;
      }
      amount = round2(zen - offset); // tracker = zen − offset
    } else {
      amount = round2(zen); // zenmoney-authority: баланс точный
    }
    snapshots.push({ account: m.tracker, amount });
    nSnap++;
  }
  if (snapshots.length) {
    console.log(`  снимок балансов (${nSnap}): ` + snapshots.map((s) => `${s.account}=${s.amount}`).join(', '));
    if (!DRY) {
      try { await api('POST', '/snapshot', { balances: snapshots }); }
      catch (e) { console.error(`  ✗ snapshot: ${e.message}`); }
    }
  }
  for (const w of warns) console.log(`  ⚠ ${w}`);

  // --- Операции log_only (по курсору; backfill — фильтр по дате старта трекера) ---
  const txs = (data.transaction || [])
    .filter((t) => !t.deleted)
    .filter((t) => !backfill || String(t.date) >= START_DATE)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))); // хронологически

  let nEv = 0, nDedup = 0, nErr = 0;
  for (const tx of txs) {
    const body = txToEvent(tx);
    if (!body) continue;
    const leg = body.from || body.to;
    const label = `${body.type} ${leg} ${body.amount}${body.amount_to ? '→' + body.amount_to : ''} «${body.note || ''}»`;
    if (DRY) { console.log(`  event ${tx.date} ${label}`); nEv++; continue; }
    try {
      const res = await api('POST', '/event', body);
      if (res.deduped) nDedup++; else nEv++;
    } catch (e) {
      nErr++;
      console.error(`  ✗ event zen_${tx.id}: ${e.message}`);
    }
    await sleep(250); // щадим read-quota Sheets (дедуп-скан лога на каждый /event)
  }

  // Курсор двигаем только в боевом проходе (не dry, не --full) И только если не было
  // ошибок — иначе упавшие события уедут за курсор и обычный прогон их не переотправит
  // (восстановление — через --full, дедуп по client_id защитит уже записанные).
  const newCursor = data.serverTimestamp;
  if (!DRY && !FULL && nErr === 0) { state.serverTimestamp = newCursor; saveState(state); }
  console.log(`[poll${DRY ? ' DRY' : ''}] события: новых ${nEv}, дедуп ${nDedup}` +
    (nErr ? `, ошибок ${nErr}` : '') + `; курсор→${DRY || FULL ? '(не сохранён)' : newCursor}`);
}

// --- Точка входа ---
if (process.argv.includes('--set-anchor')) {
  await setAnchor();
} else {
  await poll();
}
