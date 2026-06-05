// Storage backend: Google Sheets (spreadsheet with two tabs: Events + Balances).
// Auth: a Google service-account JWT (RS256, signed via WebCrypto) is exchanged
// for an OAuth access token, which is cached in-isolate until it expires.
//
// Config comes through env (see wrangler.toml):
//   SPREADSHEET_ID        — the target spreadsheet id
//   GOOGLE_SA_JSON        — full service-account JSON (secret)
//   APP_TOKEN             — bearer token the PWA sends (secret)
//   DEFAULT_ACCOUNT_*     — account id quick-expense routes to per currency
//
// No personal values live in code — this is a public template.
//
// === Sheet schema ===
// Events  (row 1 = headers): A:id  B:type  C:from  D:to  E:amount  F:amount_to  G:note  H:at  I:client_id
// Balances(row 1 = headers): A:id  B:name  C:amount  D:currency  |  E1 label "Обновлено", F1 = updated_at ISO
//
// Both sheets are read/written with valueInputOption=RAW (no locale parsing) and
// valueRenderOption=UNFORMATTED_VALUE (numbers come back as numbers, the ISO `at`
// stays a plain string). The user may hand-edit either sheet — the Worker never
// assumes it is the only writer beyond the per-request read→mutate→write window.

const WEEKDAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const EVENTS_SHEET = 'Events';
const BALANCES_SHEET = 'Balances';
// Column order the Worker reads/writes for the Events sheet.
const EVENT_COLS = ['id', 'type', 'from', 'to', 'amount', 'amount_to', 'note', 'at', 'client_id'];

export default {
  async fetch(req, env) {
    const auth = req.headers.get('Authorization') || '';
    if (!env.APP_TOKEN || auth !== `Bearer ${env.APP_TOKEN}`) {
      return error(401, 'unauthorized');
    }

    const url = new URL(req.url);

    try {
      if (req.method === 'GET' && url.pathname === '/api/balances') return await getBalances(env);
      if (req.method === 'GET' && url.pathname === '/api/day') return await getDay(req, env);
      if (req.method === 'POST' && url.pathname === '/api/event') return await handleEvent(req, env);
      if (req.method === 'DELETE' && url.pathname === '/api/event/last') return await handleEventDelete(env);
      if (req.method === 'POST' && url.pathname === '/api/expense') return await handleQuickExpense(req, env);
    } catch (e) {
      return error(502, `sheets: ${e.message}`);
    }

    return error(404, 'not found');
  },
};

// === RESPONSE HELPERS ===

function json(payload) {
  return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
}
function ok(data) {
  return new Response(JSON.stringify({ ok: true, ...data }), { headers: JSON_HEADERS });
}
function error(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSON_HEADERS });
}

// === DATE / PARSING HELPERS ===

const pad = (n) => String(n).padStart(2, '0');

// Currency tokens recognized in quick-expense text. Stripped from description,
// used to route to a default account (via env.DEFAULT_ACCOUNT_USDT / _RUB / _THB).
// Unicode-aware word boundaries: JS \b is ASCII-only, so "руб" wouldn't match
// at cyrillic boundaries. Lookbehind/ahead on letter/number guard against
// false positives like "рубероид" / "рубашку".
const CURRENCY_TOKEN_RE = /(?<![\p{L}\p{N}_])(usdt|rub|руб)(?![\p{L}\p{N}_])/giu;

function defaultAccountByCurrency(env) {
  return { USDT: env.DEFAULT_ACCOUNT_USDT, RUB: env.DEFAULT_ACCOUNT_RUB, THB: env.DEFAULT_ACCOUNT_THB };
}

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
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  const dt = new Date(Date.UTC(year, month - 1, day));
  const weekdayRu = WEEKDAYS_RU[dt.getUTCDay()];
  const monthEn = MONTHS_EN[month - 1];
  return {
    year, month, day, weekdayRu, monthEn,
    sectionHeader: `## ${pad(day)}.${pad(month)}.${year}, ${weekdayRu}`,
  };
}

function bangkokDateOf(iso) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// === BALANCES (read Balances sheet → {updated_at, accounts}) ===

async function getBalances(env) {
  const { accounts, updatedAt } = await readBalances(env);
  return json({ updated_at: updatedAt, accounts });
}

// === DAY (filters expense events from the Events sheet for a given Bangkok day) ===

async function getDay(req, env) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');

  let ctx;
  if (dateParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return error(400, 'date must be YYYY-MM-DD');
    ctx = bangkokContext(`${dateParam}T12:00:00+07:00`);
  } else {
    ctx = bangkokContext();
  }

  const dateISO = `${ctx.year}-${pad(ctx.month)}-${pad(ctx.day)}`;

  const [events, { accounts }] = await Promise.all([readEvents(env), readBalances(env)]);

  const accountCurrency = {};
  for (const a of accounts) accountCurrency[a.id] = a.currency;

  const expenses = events
    .filter((ev) => ev.type === 'expense' && ev.at && bangkokDateOf(ev.at) === dateISO)
    .map((ev) => ({
      description: ev.note || (ev.from ? `с ${ev.from}` : 'расход'),
      amount: ev.amount,
      currency: accountCurrency[ev.from] || 'THB',
      source: 'event',
      from: ev.from,
      id: ev.id,
    }));

  const totals = {};
  for (const e of expenses) totals[e.currency] = (totals[e.currency] || 0) + e.amount;

  return json({ date: dateISO, section: ctx.sectionHeader, expenses, totals });
}

// === QUICK EXPENSE (POST /api/expense) — main screen of PWA ===

async function handleQuickExpense(req, env) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  if (!body || typeof body.text !== 'string') return error(400, 'missing field "text"');

  let parsed;
  try { parsed = parseExpense(body.text); } catch (e) { return error(400, e.message); }

  const defaults = defaultAccountByCurrency(env);
  const from = defaults[parsed.currency || 'THB'];
  if (!from) return error(500, `no default account configured for currency ${parsed.currency || 'THB'}`);

  return createEvent(env, {
    type: 'expense',
    from,
    amount: parsed.amount,
    note: parsed.description,
    at: body.now,
    client_id: body.client_id,
  });
}

// === EVENTS ===

function validateEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'invalid body' };
  const types = ['income', 'transfer', 'exchange', 'expense'];
  if (!types.includes(body.type)) return { ok: false, message: 'type must be income/transfer/exchange/expense' };
  if (typeof body.amount !== 'number' || !isFinite(body.amount) || body.amount <= 0) {
    return { ok: false, message: 'amount must be positive number' };
  }
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
    if (typeof body.amount_to !== 'number' || !isFinite(body.amount_to) || body.amount_to <= 0) {
      return { ok: false, message: 'amount_to must be positive number' };
    }
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return { ok: false, message: 'note must be string' };
  }
  if (body.at !== undefined && body.at !== null) {
    if (typeof body.at !== 'string') return { ok: false, message: 'at must be ISO string' };
    const d = new Date(body.at);
    if (isNaN(d.getTime())) return { ok: false, message: 'at is not valid date' };
    if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return { ok: false, message: 'at cannot be in the future' };
  }
  if (body.client_id !== undefined && body.client_id !== null) {
    if (typeof body.client_id !== 'string' || body.client_id.length > 64) {
      return { ok: false, message: 'client_id must be string ≤64 chars' };
    }
  }
  return { ok: true };
}

function findAccount(accounts, id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) throw new Error(`unknown account: ${id}`);
  return acc;
}

function roundCents(accounts) {
  for (const a of accounts) a.amount = Math.round(a.amount * 100) / 100;
  return accounts;
}

function applyMutation(accounts, event) {
  if (event.type === 'income') {
    findAccount(accounts, event.to).amount += event.amount;
  } else if (event.type === 'expense') {
    findAccount(accounts, event.from).amount -= event.amount;
  } else if (event.type === 'transfer') {
    const from = findAccount(accounts, event.from);
    const to = findAccount(accounts, event.to);
    if (from.currency !== to.currency) throw new Error('transfer requires same currency');
    from.amount -= event.amount;
    to.amount += event.amount;
  } else if (event.type === 'exchange') {
    findAccount(accounts, event.from).amount -= event.amount;
    findAccount(accounts, event.to).amount += event.amount_to;
  } else {
    throw new Error(`unknown event type: ${event.type}`);
  }
  return roundCents(accounts);
}

function reverseMutation(accounts, event) {
  if (event.type === 'income') {
    findAccount(accounts, event.to).amount -= event.amount;
  } else if (event.type === 'expense') {
    findAccount(accounts, event.from).amount += event.amount;
  } else if (event.type === 'transfer') {
    findAccount(accounts, event.from).amount += event.amount;
    findAccount(accounts, event.to).amount -= event.amount;
  } else if (event.type === 'exchange') {
    findAccount(accounts, event.from).amount += event.amount;
    findAccount(accounts, event.to).amount -= event.amount_to;
  } else {
    throw new Error(`unknown event type: ${event.type}`);
  }
  return roundCents(accounts);
}

function describeEvent(ev) {
  if (ev.type === 'income') return `+${ev.amount} → ${ev.to}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'expense') return `−${ev.amount} ${ev.from}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'transfer') return `${ev.from} → ${ev.to}: ${ev.amount}${ev.note ? ` (${ev.note})` : ''}`;
  if (ev.type === 'exchange') return `${ev.from} ${ev.amount} → ${ev.to} ${ev.amount_to}${ev.note ? ` (${ev.note})` : ''}`;
  return ev.type;
}

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `ev_${crypto.randomUUID().slice(0, 12)}`;
  return `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function handleEvent(req, env) {
  let body;
  try { body = await req.json(); } catch { return error(400, 'invalid json'); }
  return createEvent(env, body);
}

async function createEvent(env, body) {
  const v = validateEvent(body);
  if (!v.ok) return error(400, v.message);

  const clientId = typeof body.client_id === 'string' && body.client_id ? body.client_id : null;

  const event = {
    id: genId(),
    type: body.type,
    from: body.from || null,
    to: body.to || null,
    amount: Math.round(body.amount * 100) / 100,
    amount_to: body.amount_to != null ? Math.round(body.amount_to * 100) / 100 : null,
    note: body.note || null,
    at: body.at ? new Date(body.at).toISOString() : new Date().toISOString(),
    client_id: clientId,
  };

  const token = await getAccessToken(env);

  // Read current balances + the event log (the latter only when we need to
  // de-duplicate a retried write). One round-trip each, in parallel.
  const [{ accounts, updatedAt }, events] = await Promise.all([
    readBalances(env, token),
    clientId ? readEvents(env, token) : Promise.resolve(null),
  ]);

  // Idempotency: if a recent event carries the same client_id, the previous POST
  // already committed — return it without a second write. Window of 200 covers
  // any plausible PWA-queue flush burst.
  if (clientId && events) {
    const existing = events.slice(-200).find((e) => e.client_id === clientId);
    if (existing) {
      const { client_id, ...publicExisting } = existing;
      return ok({ event: publicExisting, balances: { updated_at: updatedAt, accounts }, deduped: true });
    }
  }

  const newAccounts = applyMutation(accounts.map((a) => ({ ...a })), event);
  const newUpdatedAt = event.at;

  // Append the event row first (the log is the source of truth — balances can
  // always be recomputed from it), then write the new balances. Two requests:
  // Sheets has no cross-tab transaction, but for a single user the window is
  // negligible and a crash between them leaves only a recoverable drift.
  await appendEvent(env, event, token);
  await writeBalanceAmounts(env, newAccounts, newUpdatedAt, token);

  // Don't echo client_id back to the client (internal idempotency key).
  const { client_id, ...publicEvent } = event;
  return ok({ event: publicEvent, balances: { updated_at: newUpdatedAt, accounts: newAccounts } });
}

async function handleEventDelete(env) {
  const token = await getAccessToken(env);

  const [events, { accounts }] = await Promise.all([
    readEvents(env, token),
    readBalances(env, token),
  ]);

  if (events.length === 0) return error(404, 'no events to undo');

  const last = events[events.length - 1];
  const newAccounts = reverseMutation(accounts.map((a) => ({ ...a })), last);
  const updatedAt = new Date().toISOString();

  // Reverse the balance first, then drop the row. If the row delete failed the
  // log would keep a phantom entry — reversing first means balances are right
  // and a re-issued undo simply pops the same row.
  await writeBalanceAmounts(env, newAccounts, updatedAt, token);
  await deleteLastEventRow(env, events.length, token);

  const { client_id, ...publicEvent } = last;
  return ok({ undone: publicEvent, balances: { updated_at: updatedAt, accounts: newAccounts } });
}

// === GOOGLE AUTH (service-account JWT → OAuth access token) ===

// Cached per-isolate. Workers reuse isolates across requests, so most requests
// skip the token exchange entirely.
let cachedToken = null; // { value, exp } (exp in epoch ms)

function getServiceAccount(env) {
  if (!env.GOOGLE_SA_JSON) throw new Error('GOOGLE_SA_JSON not configured');
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SA_JSON); }
  catch { throw new Error('GOOGLE_SA_JSON is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SA_JSON missing client_email/private_key');
  return sa;
}

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && cachedToken.exp > now + 60_000) return cachedToken.value;

  const sa = getServiceAccount(env);
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch(claim.aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, exp: now + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(body);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// === GOOGLE SHEETS API ===

function sheetsHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function sheetsValuesGet(env, range, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`values.get ${range} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

async function readBalances(env, token) {
  token = token || await getAccessToken(env);
  // A1:F covers id/name/amount/currency plus the updated_at cell at F1.
  const rows = await sheetsValuesGet(env, `${BALANCES_SHEET}!A1:F`, token);
  const updatedAt = (rows[0] && rows[0][5] != null && rows[0][5] !== '') ? String(rows[0][5]) : null;
  const accounts = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = r[0];
    if (id == null || id === '') continue;
    accounts.push({
      id: String(id),
      name: r[1] != null ? String(r[1]) : '',
      amount: typeof r[2] === 'number' ? r[2] : parseFloat(r[2]) || 0,
      currency: r[3] != null ? String(r[3]) : '',
    });
  }
  return { accounts, updatedAt };
}

async function readEvents(env, token) {
  token = token || await getAccessToken(env);
  const rows = await sheetsValuesGet(env, `${EVENTS_SHEET}!A2:I`, token);
  const events = [];
  for (const r of rows) {
    if (r[0] == null || r[0] === '') continue;
    events.push(rowToEvent(r));
  }
  return events;
}

function rowToEvent(r) {
  const cell = (i) => (r[i] === undefined || r[i] === '' ? null : r[i]);
  const num = (i) => {
    const v = cell(i);
    if (v == null) return null;
    return typeof v === 'number' ? v : parseFloat(v);
  };
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
  return EVENT_COLS.map((c) => {
    const v = ev[c];
    return v == null ? '' : v;
  });
}

async function appendEvent(env, event, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(EVENTS_SHEET + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sheetsHeaders(token),
    body: JSON.stringify({ values: [eventToRow(event)] }),
  });
  if (!res.ok) throw new Error(`values.append ${res.status}: ${await res.text()}`);
}

// Writes the amount column (C2:C{n+1}) and the updated_at cell (F1) in one
// atomic values.batchUpdate. Amounts are written by row position, matching the
// order they were just read in.
async function writeBalanceAmounts(env, accounts, updatedAt, token) {
  const lastRow = accounts.length + 1;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sheetsHeaders(token),
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [
        { range: `${BALANCES_SHEET}!C2:C${lastRow}`, values: accounts.map((a) => [a.amount]) },
        { range: `${BALANCES_SHEET}!F1`, values: [[updatedAt]] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`values.batchUpdate ${res.status}: ${await res.text()}`);
}

// sheetId (gid) per tab title, needed for structural row deletion. Cached per-isolate.
let cachedSheetIds = null;

async function getSheetId(env, title, token) {
  if (!cachedSheetIds) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`spreadsheets.get ${res.status}: ${await res.text()}`);
    const data = await res.json();
    cachedSheetIds = {};
    for (const s of data.sheets || []) cachedSheetIds[s.properties.title] = s.properties.sheetId;
  }
  const id = cachedSheetIds[title];
  if (id == null) throw new Error(`sheet not found: ${title}`);
  return id;
}

// Deletes the last data row of the Events sheet. eventCount = number of data
// rows (header excluded); the row to drop is at zero-based index eventCount
// (header is index 0).
async function deleteLastEventRow(env, eventCount, token) {
  const sheetId = await getSheetId(env, EVENTS_SHEET, token);
  const startIndex = eventCount; // header at 0, data rows at 1..eventCount
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sheetsHeaders(token),
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + 1 },
        },
      }],
    }),
  });
  if (!res.ok) throw new Error(`batchUpdate(delete) ${res.status}: ${await res.text()}`);
}

// === BASE64 HELPERS ===

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64urlBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url(text) {
  return base64urlBytes(new TextEncoder().encode(text));
}
