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

  // TODO(v2): сверка целостности «снимок ?= стартовый баланс + Σ операций из лога».
  // Здесь читаем GET /api/events (весь лог, с фильтрами ?type=/?limit=), сворачиваем
  // мутации (applyMutation-логика: income/+, expense/−, transfer, exchange) от известной
  // стартовой точки каждого счёта и сравниваем с текущим amount из /api/balances.
  // Расхождение сверх epsilon (учитывая log_only-события, которые баланс НЕ двигают, и
  // счета, зеркалимые снимком) → тревога «дрейф баланса». В v1 НЕ реализовано намеренно:
  // v1 ловит только устаревание updated_at (самый частый и дешёвый сигнал поломки).
}

main().catch((e) => die(e.message));
