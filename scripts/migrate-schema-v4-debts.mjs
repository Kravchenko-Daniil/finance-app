#!/usr/bin/env node
// Schema migration v4 — adds a hidden `hidden` marker column (G) to the Balances
// sheet plus 6 debt/deposit accounts (VTB car loan, Alfa credit card, MTS loan,
// T-Bank loan, T-Bank Platinum, VTB deposit). The new accounts start at amount 0;
// the real numbers are written by the first POST /api/snapshot from the ZenMoney
// poller. The `hidden` column lets the Totals exclude these accounts from the per-
// currency sums (a debt is not spendable liquidity). See aggregator-design.md.
//
// ⚠️  Run scripts/backup-sheets.mjs FIRST — this rebuilds the whole Balances grid.
//
// What it does (whole-sheet rebuild of Balances, the v2 way — safer than splicing):
//   - reads the current Balances!A1:G, finds the accounts header by scanning
//     column A for the literal 'id' (case-insensitive),
//   - keeps F1 (raw updated_at ISO) and the B1 pretty-date formula,
//   - re-emits the header with a new G='hidden' column,
//   - re-emits every existing liquid account (G=''),
//   - appends the 6 debt accounts at the END of the liquid block (G=TRUE),
//   - one blank separator row, then the Totals block with bounded SUMIFS that
//     skip hidden rows,
//   - hides column G (hiddenByUser) via batchUpdate.
//
// Idempotent / re-runnable: existing amounts (including the 6 debt accounts if a
// snapshot already populated them) are read back by id and preserved — 0 is only
// used for an account that does not yet exist on the sheet.
//
// DRY_RUN=1 prints the plan (row placement, ds/de, formulas) and exits before any
// write.
//
// Usage:  node scripts/migrate-schema-v4-debts.mjs   (or DRY_RUN=1 node ...)

import {
  loadSA, spreadsheetId, getToken, valuesGet, valuesClear, valuesBatchUpdate,
  getMeta, batchUpdate, die,
} from './_lib.mjs';

const BALANCES = 'Balances';

// New debt / deposit accounts, appended in this order at the end of the liquid
// block. amount starts 0 (snapshot fills it), currency RUB, hidden = TRUE.
const DEBT_ACCOUNTS = [
  { id: 'vtb_carloan', name: 'VTB Автокредит' },
  { id: 'alfa_credit', name: 'Alfa Кредитка' },
  { id: 'mts_loan', name: 'МТС Займ' },
  { id: 'tbank_loan', name: 'T-Bank Кредит' },
  { id: 'tbank_platinum', name: 'T-Bank Платинум' },
  { id: 'vtb_deposit', name: 'VTB Вклад' },
];
const DEBT_IDS = new Set(DEBT_ACCOUNTS.map((a) => a.id));

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());
  const sep = ';'; // ru_RU spreadsheet locale → formula list separator

  // --- read current Balances state (A:G to capture any pre-existing G marker) ---
  const rows = await valuesGet(token, id, `${BALANCES}!A1:G`);

  // F1 = raw updated_at ISO (kept verbatim).
  const updatedAt = (rows[0] && rows[0][5] != null && rows[0][5] !== '')
    ? String(rows[0][5]) : new Date().toISOString();

  // Find the accounts header row by scanning column A for the literal 'id'.
  let headerRow = -1; // 1-based sheet row number
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i] && rows[i][0];
    if (a != null && String(a).trim().toLowerCase() === 'id') { headerRow = i + 1; break; }
  }
  if (headerRow === -1) die(`${BALANCES}: accounts header (A=='id') not found — run the v2 migration first`);

  // Read existing accounts: from the row after the header until the first blank A.
  // Preserve amount per id (idempotency); the debt accounts may already be present
  // from an earlier snapshot — keep their amount too.
  const existing = []; // { id, name, amount, currency } in sheet order
  const amountById = {};
  for (let i = headerRow; i < rows.length; i++) { // headerRow is 1-based → rows[headerRow] is the next row
    const r = rows[i];
    if (!r || r[0] == null || String(r[0]).trim() === '') break; // first blank A ends the block
    const accId = String(r[0]);
    const amount = typeof r[2] === 'number' ? r[2] : (parseFloat(r[2]) || 0);
    amountById[accId] = amount;
    existing.push({
      id: accId,
      name: r[1] != null ? String(r[1]) : accId,
      amount,
      currency: r[3] != null ? String(r[3]) : '',
    });
  }

  // Liquid accounts = existing accounts that are NOT debt accounts, in sheet order.
  const liquid = existing.filter((a) => !DEBT_IDS.has(a.id));

  // Debt accounts appended at the end. Preserve amount if already on the sheet,
  // otherwise 0. Always currency RUB, hidden = TRUE.
  const debts = DEBT_ACCOUNTS.map((d) => ({
    id: d.id,
    name: d.name,
    amount: Object.prototype.hasOwnProperty.call(amountById, d.id) ? amountById[d.id] : 0,
    currency: 'RUB',
    hidden: true,
  }));

  // Final account block: liquid (hidden='') then debts (hidden=TRUE).
  const accounts = [
    ...liquid.map((a) => ({ ...a, hidden: false })),
    ...debts,
  ];

  // Row geometry for the rebuilt block.
  const dataStart = headerRow + 1;
  const dataEnd = dataStart + accounts.length - 1;
  const totalsHeaderRow = dataEnd + 2;     // one blank separator row
  const totalsStart = totalsHeaderRow + 1;

  // Currencies for Totals, in appearance order across the whole block.
  const currencies = [];
  for (const a of accounts) if (a.currency && !currencies.includes(a.currency)) currencies.push(a.currency);

  // Bounded SUMIFS per currency, excluding hidden rows (G<>TRUE).
  const sumifs = (cur) =>
    `=SUMIFS($C$${dataStart}:$C$${dataEnd}${sep}$D$${dataStart}:$D$${dataEnd}${sep}"${cur}"${sep}$G$${dataStart}:$G$${dataEnd}${sep}"<>TRUE")`;

  // --- preview ---
  console.log(`Spreadsheet: ${id}`);
  console.log(`Accounts header row (A=='id'): ${headerRow}`);
  console.log(`Liquid accounts kept: ${liquid.length}; debt accounts: ${debts.length}; total: ${accounts.length}`);
  console.log(`Data rows: ${dataStart}..${dataEnd}  |  Totals header: ${totalsHeaderRow}, values: ${totalsStart}..${totalsStart + currencies.length - 1}`);
  console.log('\nAccount block (id | amount | cur | hidden | name):');
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    console.log(`  row ${dataStart + i}: ${a.id.padEnd(16)} ${String(a.amount).padStart(12)} ${a.currency.padEnd(4)} ${a.hidden ? 'TRUE ' : '     '} ${a.name}`);
  }
  console.log(`\nTotals (${currencies.length}):`);
  currencies.forEach((c) => console.log(`  ${c}: ${sumifs(c)}`));
  console.log('\nColumn G ("hidden") will be hidden (hiddenByUser, startIndex 6, endIndex 7).');

  if (process.env.DRY_RUN) { console.log('\n✓ DRY_RUN — nothing written.'); return; }

  // --- find Balances sheetId (for the column-hide batchUpdate) ---
  const meta = await getMeta(token, id, 'sheets.properties(sheetId,title)');
  const sheet = (meta.sheets || []).find((s) => s.properties && s.properties.title === BALANCES);
  if (!sheet) die(`sheet not found: ${BALANCES}`);
  const sheetId = sheet.properties.sheetId;

  // --- build writes ---
  // RAW: text / numbers / raw ISO / the G hidden markers ('' or boolean true).
  const rawData = [
    { range: `${BALANCES}!F1`, values: [[updatedAt]] },
    { range: `${BALANCES}!A${headerRow}:G${headerRow}`, values: [['id', 'NAME', 'AMOUNT', 'CURRENCY', '', '', 'hidden']] },
    {
      range: `${BALANCES}!A${dataStart}:G${dataEnd}`,
      values: accounts.map((a) => [a.id, a.name, a.amount, a.currency, '', '', a.hidden ? true : '']),
    },
    { range: `${BALANCES}!B${totalsHeaderRow}`, values: [['Totals']] },
    { range: `${BALANCES}!A${totalsStart}:A${totalsStart + currencies.length - 1}`, values: currencies.map((c) => [c]) },
  ];

  // USER_ENTERED: the SUMIFS formulas (the B1 pretty-date formula is preserved as-is;
  // we don't clear B1, so it stays intact — only the block below the header is rebuilt).
  const formulaData = [
    {
      range: `${BALANCES}!C${totalsStart}:C${totalsStart + currencies.length - 1}`,
      values: currencies.map((c) => [sumifs(c)]),
    },
  ];

  // Clear only from the header row down (keep rows above: Updated / B1 formula / F1 /
  // E1 mirror). Clearing A{headerRow}:Z removes the old account block + old Totals so
  // a shrunk/rearranged block can't leave stale rows behind.
  await valuesClear(token, id, `${BALANCES}!A${headerRow}:Z`);
  await valuesBatchUpdate(token, id, rawData, 'RAW');
  await valuesBatchUpdate(token, id, formulaData, 'USER_ENTERED');
  console.log(`\n✓ Balances rebuilt (${accounts.length} accounts: ${liquid.length} liquid + ${debts.length} debt; totals: ${currencies.join('/')})`);

  // --- hide column G ---
  await batchUpdate(token, id, [{
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  }]);
  console.log('✓ Column G ("hidden") hidden.');
  console.log('\n✓ Migration v4 complete. Debt amounts start 0 — first POST /api/snapshot fills them.');
})().catch((e) => die(e.stack || e.message));
