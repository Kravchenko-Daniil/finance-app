#!/usr/bin/env node
// Сторож СВЕЖЕСТИ данных (не живости процесса). Урок из aggregator-design.md:
// поллер был жив и стабильно писал «новых 0», пока источник (банк/API) молчал
// две недели незамеченным. Живой процесс ≠ свежие данные. Этот сторож смотрит
// НЕ на то, крутится ли cron, а на то, ОБНОВЛЯЮТСЯ ли балансы в таблице:
// читает GET /api/balances → updated_at; если он старше порога — тревога.
//
// v1 скоуп: ТОЛЬКО свежесть updated_at. Сверку «снимок ?= старт + Σ операций
// из лога» см. TODO ниже (v2) — она встанет отдельным чеком поверх GET /api/events.
//
// Канал пуша ПЛАГГЕБЛ (открытый вопрос владельца — чем оповещать):
//   • заданы WATCHDOG_TELEGRAM_BOT_TOKEN + WATCHDOG_TELEGRAM_CHAT_ID
//     → шлём в Telegram Bot API;
//   • иначе → печать тревоги в stderr + ненулевой exit (cron/лог поймает).
// Никаких креденшелов/каналов в коде — всё через .env.
//
// Режимы:
//   --dry-run   печатает, что БЫ отправил, без реального пуша (exit 0 при тревоге)
//   (без флага) боевой прогон: тревога → пуш (или stderr+exit≠0, если канал не задан)
//
// Креды/токен из .env (в stdout НЕ попадают): APP_TOKEN, опц. WATCHDOG_TELEGRAM_*.
//
// Примеры:
//   node scripts/watchdog.mjs --dry-run     # превью, ничего не шлёт
//   node scripts/watchdog.mjs               # боевой прогон (cron)
//   WATCHDOG_MAX_AGE_H=24 node scripts/watchdog.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV = join(ROOT, '.env');

const API_BASE = 'https://finance.daniilkravchenko.com/api';
// Браузерный UA обязателен — без него Cloudflare WAF отдаёт 403 / error 1010.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_MAX_AGE_H = 48;

const DRY = process.argv.includes('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }

// --- .env (не хардкод, значения в stdout не печатаем) ---
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

// --- finance-API (ретрай транзиентных сбоев с backoff, dependency-free) ---
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

// --- Канал пуша: плаггебл через env, без хардкода креденшелов ---
// Telegram сконфигурирован ⇔ заданы ОБА ключа. Иначе — «нет канала».
function telegramConfigured() {
  return !!(env('WATCHDOG_TELEGRAM_BOT_TOKEN', false) && env('WATCHDOG_TELEGRAM_CHAT_ID', false));
}

async function sendTelegram(text, attempt = 0) {
  const token = env('WATCHDOG_TELEGRAM_BOT_TOKEN');
  const chatId = env('WATCHDOG_TELEGRAM_CHAT_ID');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (res.ok) return;
  const body = (await res.text()).slice(0, 200);
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Math.min(20000, 2000 * 2 ** attempt);
    console.error(`  · Telegram ${res.status} — retry через ${wait / 1000}s (${attempt + 1}/4)`);
    await sleep(wait);
    return sendTelegram(text, attempt + 1);
  }
  throw new Error(`Telegram sendMessage ${res.status}: ${body}`);
}

// Отправить тревогу выбранным каналом. Возвращает true, если тревога «доставлена»
// каналом (Telegram); false — если канал не сконфигурирован (тогда caller ставит
// ненулевой exit, чтобы cron/лог заметил). При --dry-run только печатаем план.
async function alert(text) {
  if (DRY) {
    const via = telegramConfigured() ? 'Telegram' : 'stderr (канал не задан)';
    console.log(`[watchdog DRY] тревога → ${via}:\n${text}`);
    return true;
  }
  if (telegramConfigured()) {
    await sendTelegram(text);
    console.log('[watchdog] тревога отправлена в Telegram');
    return true;
  }
  // Канал не сконфигурирован — не падаем, печатаем в stderr. Ненулевой exit
  // (его выставит main) — чтобы cron/systemd/лог зафиксировали проблему.
  console.error(`[watchdog] ТРЕВОГА (канал пуша не сконфигурирован):\n${text}`);
  return false;
}

// --- Проверка свежести updated_at ---
async function main() {
  const maxAgeH = Number(env('WATCHDOG_MAX_AGE_H', false)) || DEFAULT_MAX_AGE_H;
  const maxAgeMs = maxAgeH * 3600 * 1000;

  const data = await api('GET', '/balances');
  const updatedAt = data.updated_at;
  if (!updatedAt) {
    // Нет метки времени вообще — это тоже сигнал устаревания/поломки.
    const delivered = await alert(
      `⚠ Финансы: в /api/balances нет updated_at — не могу оценить свежесть данных.`
    );
    process.exit(delivered ? 0 : 1);
  }

  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) {
    const delivered = await alert(
      `⚠ Финансы: updated_at «${updatedAt}» не парсится как дата — проверь формат.`
    );
    process.exit(delivered ? 0 : 1);
  }

  const ageMs = Date.now() - updatedMs;
  const ageH = Math.round((ageMs / 3600000) * 10) / 10;
  console.log(`[watchdog${DRY ? ' DRY' : ''}] updated_at=${updatedAt} · возраст ${ageH}ч · порог ${maxAgeH}ч`);

  if (ageMs > maxAgeMs) {
    const nAcc = Array.isArray(data.accounts) ? data.accounts.length : '?';
    const delivered = await alert(
      `⚠ Финансы: данные устарели ${ageH}ч (порог ${maxAgeH}ч).\n` +
      `updated_at=${updatedAt}, счетов=${nAcc}.\n` +
      `Похоже, поллер/источник молчит — проверь ZenMoney/bybit/MaxSwap.`
    );
    // Тревога доставлена каналом → exit 0; канала нет → exit 1 (cron заметит).
    process.exit(delivered ? 0 : 1);
  }

  console.log(`[watchdog${DRY ? ' DRY' : ''}] OK — данные свежие`);

  // v2: сверка целостности «снимок ?= старт + Σ операций из лога».
  await reconcile(data);
}

// --- v2: сверка целостности зеркалимых счетов ----------------------------------
// Расхождение считаем значимым, если |дельта| > EPS (копеечный шум float — не сигнал).
const RECON_EPS = 0.01;
const cents = (x) => Math.round(x * 100) / 100;

// Вклад ОДНОГО события в баланс КОНКРЕТНОГО счёта (та же логика, что applyMutation
// в api/src/index.js:731-749, но развёрнутая «по счёту»: сколько это событие
// прибавляет/убавляет именно на acc). Событие ссылается на счёт через from/to.
//   income   : +amount     на to
//   expense  : −amount     с from
//   transfer : −amount c from, +amount на to (та же валюта)
//   exchange : −amount c from, +amount_to на to (разные валюты — потому amount_to)
// Счёт, не затронутый событием, получает 0.
function deltaForAccount(event, acc) {
  const amt = event.amount || 0;
  const amtTo = event.amount_to || 0;
  switch (event.type) {
    case 'income':
      return event.to === acc ? amt : 0;
    case 'expense':
      return event.from === acc ? -amt : 0;
    case 'transfer':
      return (event.from === acc ? -amt : 0) + (event.to === acc ? amt : 0);
    case 'exchange':
      return (event.from === acc ? -amt : 0) + (event.to === acc ? amtTo : 0);
    default:
      return 0; // неизвестный тип — не двигаем (как и applyMutation бросил бы, но здесь мягко)
  }
}

// Модель (api/src/index.js): зеркалимые счета ведутся СНИМКОМ (authority=direct, баланс
// SET из источника), а log_only:true события баланс НЕ двигают — они и есть «поток
// операций» для этих счетов. Сверка проверяет полноту потока: если снимок=X, а свёртка
// log_only-операций счёта=Y, то дельта X−Y = пропущенные/лишние операции.
//
// СТАРТ свёртки = 0 (дефолт по спеке crypto-reconciliation.md:113): сворачиваем ВСЕ
// log_only-события счёта от нуля. Явный anchor в Balances спекой допускается, но не
// используется — старт нулевой, поэтому «старт + Σоп» = чистая Σ log_only-мутаций.
//
// МНОЖЕСТВО зеркалимых счетов выводим ДАННЫМИ, а не хардкодом: зеркалимый счёт — это
// любой счёт, на который ссылается хотя бы одно log_only-событие (crypto trustwallet/
// bybit, maxswap, zenmoney-счета — их поллеры пишут поток именно log_only-событиями).
// Так набор переживает переименования/новые источники без правок кода.
async function reconcile(balances) {
  const snapshot = new Map();
  for (const a of (balances.accounts || [])) snapshot.set(a.id, a);

  const { events } = await api('GET', '/events'); // весь лог, oldest-first
  const logOnly = (events || []).filter((e) => e.log_only === true);

  // Зеркалимые счета = все счета, упомянутые в log_only-событиях (from/to).
  const mirrored = new Set();
  for (const e of logOnly) {
    if (e.from) mirrored.add(e.from);
    if (e.to) mirrored.add(e.to);
  }

  if (mirrored.size === 0) {
    console.log(`[watchdog${DRY ? ' DRY' : ''}] сверка: log_only-событий нет — нечего сверять`);
    return;
  }

  const drift = [];
  console.log(`[watchdog${DRY ? ' DRY' : ''}] сверка целостности (старт=0, Σ log_only-операций):`);
  for (const acc of [...mirrored].sort()) {
    // Σ операций счёта = свёртка вкладов всех его log_only-событий от старта 0.
    let sum = 0;
    for (const e of logOnly) sum += deltaForAccount(e, acc);
    const computed = cents(sum);          // старт(0) + Σоп
    const snap = snapshot.get(acc);
    const snapAmt = snap ? cents(snap.amount) : null;
    const delta = snapAmt == null ? null : cents(snapAmt - computed);
    const snapStr = snapAmt == null ? 'нет в /api/balances' : snapAmt;
    console.log(`  ${acc}: снимок=${snapStr}, старт+Σоп=${computed}, дельта=${delta == null ? '—' : delta}`);
    if (delta != null && Math.abs(delta) > RECON_EPS) {
      drift.push({ acc, snap: snapAmt, computed, delta });
    }
  }

  if (drift.length === 0) {
    console.log(`[watchdog${DRY ? ' DRY' : ''}] сверка OK — целостность потока сходится`);
    return;
  }

  const lines = drift.map(
    (d) => `• ${d.acc}: снимок=${d.snap}, старт+Σоп=${d.computed}, дельта=${d.delta}`
  );
  const delivered = await alert(
    `⚠ Финансы: дрейф баланса — снимок не сходится с потоком log_only-операций.\n` +
    `Дельта = пропущенные/лишние операции в логе по счёту:\n${lines.join('\n')}`
  );
  // Тревога доставлена каналом (или dry-run) → exit 0; канала нет → exit 1 (cron заметит).
  process.exit(delivered ? 0 : 1);
}

main().catch((e) => die(e.message));
