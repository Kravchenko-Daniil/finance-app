#!/usr/bin/env node
// One-off seeding script for the `Recurring` sheet (recurring-payments tracker,
// see specs/recurring-payments-tracker.md step 2). Creates the sheet if it does
// not exist yet, writes the header row + the seed credits below it, and applies
// cosmetics (freeze, hidden machine columns, widths, per-currency number format).
//
// ⚠️  PLACEHOLDER DATA. The CREDITS array below is filled with placeholder amounts
// (T-Bank credit card / VTB loan / MTS loan / Alfa credit card) — Даниил ещё не
// прислал реальные суммы/даты. Replace amount/due_day/owed with the real numbers
// before the real (non-DRY_RUN) run that matters, or re-run this script again
// later (see idempotency note below).
//
// ⚠️  Adding a credit BY HAND later (in the sheet, not via this script)? Fill
// CYCLE with the seeding month too — «добавляя кредит руками, заполни CYCLE
// месяцем». An empty CYCLE is a safe no-accrual fallback (owed stays frozen at
// the seeded number forever), not the normal mode — Model B (see the spec)
// requires CYCLE as the accrual anchor so the debt keeps growing every month
// even if nobody pays.
//
// Schema (spec step 1), row 1 headers, hidden columns A (id) and I (CYCLE):
//   A:id  B:NAME  C:AMOUNT  D:CURRENCY  E:DUE_DAY  F:OWED  G:LAST_PAID  H:NEXT_DUE  I:CYCLE
//
// Idempotent / re-runnable: if a `Recurring` sheet already exists it is deleted
// and recreated from scratch (cheap — this is a small hand-curated sheet, unlike
// the whole-sheet-rebuild-with-preserved-amounts dance in migrate-schema-v4-debts.mjs
// for the much bigger, API-mutated Balances sheet). Re-running always reseeds
// CREDITS as written below — if you already made payments through the API,
// re-running this script will WIPE that progress. Only re-run to fix the schema
// or seed data before real usage starts.
//
// addSheet is new to this repo (grep addSheet scripts/*.mjs was empty before this
// file — migrate-schema-v2/v3/v4 all edit sheets that already exist). Standard
// Sheets API call, but the new sheetId must be read back from the response
// (`replies[0].addSheet.properties.sheetId`) — needed by the cosmetics batchUpdate
// below (hidden/freeze/width address by sheetId, not by title).
//
// DRY_RUN=1 prints the plan (rows, geometry) and exits BEFORE any network call —
// including getToken/getMeta — so it never needs a service-account key either.
//
// Usage:  node scripts/create-recurring-sheet.mjs   (or DRY_RUN=1 node ...)

import {
  loadSA, spreadsheetId, getToken, valuesUpdate, getMeta, batchUpdate, die,
  numFmtCur,
} from './_lib.mjs';

const RECURRING = 'Recurring';
const RECURRING_COLS = ['id', 'name', 'amount', 'currency', 'due_day', 'owed', 'last_paid', 'next_due', 'cycle'];
const HEADER_ROW = ['id', 'NAME', 'AMOUNT', 'CURRENCY', 'DUE_DAY', 'OWED', 'LAST_PAID', 'NEXT_DUE', 'CYCLE'];

// --- seed credits (PLACEHOLDERS — replace before the real run) ---
// amount = monthly norm, owed = current debt already due (includes this month's
// norm), due_day = day of month 1..31 (clamped to month length by the API).
const CREDITS = [
  { id: 'rec_tbank_cc', name: 'T-Bank Кредитка', amount: 5000, currency: 'RUB', due_day: 15, owed: 5000 },
  { id: 'rec_vtb_credit', name: 'VTB Кредит', amount: 12000, currency: 'RUB', due_day: 20, owed: 12000 },
  { id: 'rec_mts_credit', name: 'МТС Кредит', amount: 3000, currency: 'RUB', due_day: 5, owed: 3000 },
  { id: 'rec_alfa_cc', name: 'Alfa Кредитка', amount: 4000, currency: 'RUB', due_day: 25, owed: 4000 },
];

// Seeding month YYYY-MM, UTC-based (this is an operator script, not the API — it
// does not have access to the KV timezone config; a one-month-boundary skew here
// is harmless, the very next read just accrues from wherever CYCLE lands).
function currentYM(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// --- small local cosmetic helpers (mirrors format-sheets.mjs; kept local since
// they're plain batchUpdate-request builders, not shared money-format data) ---
const HEADER_BG = { red: 0.20, green: 0.29, blue: 0.37 };
const WHITE = { red: 1, green: 1, blue: 1 };
const GRID = { red: 0.75, green: 0.75, blue: 0.75 };
const border = { style: 'SOLID', width: 1, color: GRID };
const R = (sheetId, r0, r1, c0, c1) => {
  const range = { sheetId, startColumnIndex: c0, endColumnIndex: c1 };
  if (r0 != null) range.startRowIndex = r0;
  if (r1 != null) range.endRowIndex = r1;
  return range;
};
const header = (sheetId, row, c0, c1) => ({
  repeatCell: {
    range: R(sheetId, row, row + 1, c0, c1),
    cell: { userEnteredFormat: { backgroundColor: HEADER_BG, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: WHITE } } },
    fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)',
  },
});
const freeze = (sheetId, n) => ({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: n } }, fields: 'gridProperties.frozenRowCount' } });
const hidden = (sheetId, start, end, value) => ({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: end }, properties: { hiddenByUser: value }, fields: 'hiddenByUser' } });
const width = (sheetId, start, px) => ({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: start + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } });
const borders = (sheetId, r0, r1, c0, c1) => ({ updateBorders: { range: R(sheetId, r0, r1, c0, c1), top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border } });
const align = (sheetId, r0, r1, c, h, numfmt) => {
  const uef = { horizontalAlignment: h, verticalAlignment: 'MIDDLE' };
  let fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment';
  if (numfmt) { uef.numberFormat = numfmt; fields += ',numberFormat'; }
  fields += ')';
  return { repeatCell: { range: R(sheetId, r0, r1, c, c + 1), cell: { userEnteredFormat: uef }, fields } };
};

(async () => {
  const cycle = currentYM();
  const rows = CREDITS.map((c) => ([c.id, c.name, c.amount, c.currency, c.due_day, c.owed, '', '', cycle]));
  const n = 1 + rows.length; // header + data rows, 1-based last row

  // --- preview (no network yet) ---
  console.log(`Sheet: ${RECURRING}`);
  console.log(`Seeding CYCLE = ${cycle} (current month; CYCLE is never left empty — see header comment)`);
  console.log(`Header (row 1): ${HEADER_ROW.join(' | ')}`);
  console.log(`Credits (${CREDITS.length}), rows 2..${n}:`);
  for (let i = 0; i < CREDITS.length; i++) {
    const c = CREDITS[i];
    console.log(`  row ${2 + i}: ${c.id.padEnd(16)} ${c.name.padEnd(20)} ${String(c.amount).padStart(8)} ${c.currency.padEnd(4)} due_day=${String(c.due_day).padStart(2)} owed=${c.owed} cycle=${cycle}`);
  }
  console.log(`Range to write: ${RECURRING}!A1:I${n}`);
  console.log('Cosmetics planned: freeze row 1, header style A1:I1, hide columns A (id) and I (cycle), column widths, per-row currency number format on C (amount) and F (owed).');

  if (process.env.DRY_RUN) { console.log('\n✓ DRY_RUN — nothing read or written, no network call made.'); return; }

  const id = spreadsheetId();
  const token = await getToken(loadSA());

  // --- find or (re)create the Recurring sheet ---
  const meta = await getMeta(token, id, 'sheets.properties(sheetId,title)');
  const existing = (meta.sheets || []).find((s) => s.properties && s.properties.title === RECURRING);
  if (existing) {
    await batchUpdate(token, id, [{ deleteSheet: { sheetId: existing.properties.sheetId } }]);
    console.log(`✓ existing ${RECURRING} sheet (id ${existing.properties.sheetId}) deleted for a clean reseed`);
  }
  const addRes = await batchUpdate(token, id, [{ addSheet: { properties: { title: RECURRING } } }]);
  const sheetId = addRes.replies[0].addSheet.properties.sheetId;
  console.log(`✓ ${RECURRING} sheet created (sheetId ${sheetId})`);

  // --- write header + seed rows ---
  await valuesUpdate(token, id, `${RECURRING}!A1:I${n}`, [HEADER_ROW, ...rows]);
  console.log(`✓ header + ${rows.length} credit rows written (${RECURRING}!A1:I${n})`);
  // sanity: RECURRING_COLS documents the logical column order the API relies on —
  // keep in sync with HEADER_ROW/rows above if columns are ever reordered.
  void RECURRING_COLS;

  // --- cosmetics ---
  const reqs = [];
  reqs.push(freeze(sheetId, 1));
  reqs.push(header(sheetId, 0, 0, 9)); // A1:I1
  reqs.push(align(sheetId, 1, n, 1, 'LEFT'));   // B name
  reqs.push(align(sheetId, 1, n, 4, 'CENTER')); // E due_day
  reqs.push(align(sheetId, 1, n, 6, 'CENTER')); // G last_paid
  reqs.push(align(sheetId, 1, n, 7, 'CENTER')); // H next_due
  // per-row currency number format on C (amount) and F (owed)
  CREDITS.forEach((c, i) => {
    const fmt = numFmtCur(c.currency);
    reqs.push(align(sheetId, 1 + i, 2 + i, 2, 'RIGHT', fmt)); // C amount
    reqs.push(align(sheetId, 1 + i, 2 + i, 5, 'RIGHT', fmt)); // F owed
  });
  reqs.push(borders(sheetId, 0, n, 0, 9));
  reqs.push(hidden(sheetId, 0, 1, true)); // A id
  reqs.push(hidden(sheetId, 1, 8, false)); // B..H visible
  reqs.push(hidden(sheetId, 8, 9, true)); // I cycle
  const widths = { 1: 170, 2: 100, 3: 90, 4: 80, 5: 100, 6: 110, 7: 110 };
  for (const [c, px] of Object.entries(widths)) reqs.push(width(sheetId, Number(c), px));
  await batchUpdate(token, id, reqs);
  console.log(`✓ cosmetics applied (${reqs.length} requests)`);
  console.log(`\n✓ ${RECURRING} sheet ready: ${CREDITS.length} credits seeded, CYCLE=${cycle}.`);
})().catch((e) => die(e.stack || e.message));
