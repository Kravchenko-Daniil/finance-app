#!/usr/bin/env node
// Schema migration v3 — adds the hidden `log_only` boolean column (K) to the
// Events sheet. log_only events are logged for analytics/watchdog but never move
// a balance (the account is mirrored by POST /api/snapshot). See aggregator-design.md.
//
// What it does:
//   - verifies the Events header row 1 is present,
//   - writes 'log_only' into K1 (RAW),
//   - hides column K on the Events sheet (hiddenByUser).
// Existing rows leave K blank → read back as false (correct, no backfill needed).
//
// Idempotent: a rerun just rewrites K1 and re-hides the column — both no-ops if
// already done. DRY_RUN=1 prints the plan without writing.
//
// Usage:  node scripts/migrate-schema-v3-logonly.mjs   (or DRY_RUN=1 node ...)

import {
  loadSA, spreadsheetId, getToken, valuesGet, valuesUpdate, getMeta, batchUpdate, die,
} from './_lib.mjs';

const EVENTS = 'Events';

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());

  // --- verify Events header ---
  const headerRow = await valuesGet(token, id, `${EVENTS}!A1:K1`);
  const header = headerRow[0] || [];
  if (!header[0] || String(header[0]).trim() === '') {
    die(`${EVENTS}!A1 is empty — header row 1 not found; aborting (run the v2 migration first)`);
  }
  const existingK = header[10] != null ? String(header[10]) : '';

  // --- find the Events sheetId (needed for the column-hide batchUpdate) ---
  const meta = await getMeta(token, id, 'sheets.properties(sheetId,title)');
  const sheet = (meta.sheets || []).find((s) => s.properties && s.properties.title === EVENTS);
  if (!sheet) die(`sheet not found: ${EVENTS}`);
  const sheetId = sheet.properties.sheetId;

  console.log(`Spreadsheet: ${id}`);
  console.log(`Events sheetId: ${sheetId}`);
  console.log(`Current header: ${header.map((h) => h ?? '').join(' | ')}`);
  console.log(`K1 currently: ${existingK === '' ? '(empty)' : `"${existingK}"`} → will set to "log_only"`);
  console.log('Plan: write K1="log_only" (RAW); hide column K (startIndex 10, endIndex 11).');

  if (process.env.DRY_RUN) { console.log('\n✓ DRY_RUN — nothing written.'); return; }

  // --- write K1 header (RAW) ---
  await valuesUpdate(token, id, `${EVENTS}!K1`, [['log_only']], 'RAW');
  console.log('✓ K1 = "log_only" written.');

  // --- hide column K ---
  await batchUpdate(token, id, [{
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: 10, endIndex: 11 },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  }]);
  console.log('✓ Column K hidden.');
  console.log('\n✓ Migration v3 complete. Existing rows keep K blank = log_only false.');
})().catch((e) => die(e.stack || e.message));
