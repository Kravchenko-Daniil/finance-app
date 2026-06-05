#!/usr/bin/env node
// Cosmetic formatting for the finance spreadsheet (tabs: Events + Balances).
//
// Presentation only — it never writes cell VALUES (those are owned by the Worker
// and the migration). It sets fonts, colors, borders, alignment, number formats,
// frozen/hidden columns and conditional formatting, locating data by scanning.
//
// Layout it styles (set by migrate-schema-v2.mjs):
//   Events   A:When B:Type C:From D:To E:Amount F:Received G:Note  | H:id I:at J:client_id (hidden)
//   Balances A1:"Updated" B1:date | accounts header (id/name/amount/currency) below,
//            then a Totals block. F1 = raw updated_at ISO (hidden).
//
// Re-runnable: repeatCell/border/hide/freeze overwrite; conditional rules are
// deleted first each run.  Usage:  node scripts/format-sheets.mjs

import {
  loadSA, spreadsheetId, getToken, valuesGet, getMeta, batchUpdate, die,
} from './_lib.mjs';

const EVENTS = 'Events';
const BALANCES = 'Balances';

// --- style constants ---
const HEADER_BG = { red: 0.20, green: 0.29, blue: 0.37 };
const WHITE = { red: 1, green: 1, blue: 1 };
const GREEN = { red: 0.11, green: 0.50, blue: 0.18 };
const RED = { red: 0.78, green: 0.16, blue: 0.16 };
const INFO_BG = { red: 0.93, green: 0.95, blue: 0.97 };
const GRID = { red: 0.75, green: 0.75, blue: 0.75 };
const NUMFMT = { type: 'NUMBER', pattern: '#,##0.00' }; // ru_RU: optional-decimal patterns dangle a separator
const border = { style: 'SOLID', width: 1, color: GRID };

const HEADER_FIELDS = 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)';
const headerCell = {
  userEnteredFormat: {
    backgroundColor: HEADER_BG, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
    textFormat: { bold: true, foregroundColor: WHITE },
  },
};

const R = (sheetId, r0, r1, c0, c1) => {
  const range = { sheetId, startColumnIndex: c0, endColumnIndex: c1 };
  if (r0 != null) range.startRowIndex = r0;
  if (r1 != null) range.endRowIndex = r1;
  return range;
};
function header(sheetId, row, c0, c1) {
  return { repeatCell: { range: R(sheetId, row, row + 1, c0, c1), cell: headerCell, fields: HEADER_FIELDS } };
}
function align(sheetId, r0, c, h, numfmt) {
  const uef = { horizontalAlignment: h, verticalAlignment: 'MIDDLE' };
  let fields = 'userEnteredFormat(horizontalAlignment,verticalAlignment';
  if (numfmt) { uef.numberFormat = numfmt; fields += ',numberFormat'; }
  fields += ')';
  return { repeatCell: { range: R(sheetId, r0, null, c, c + 1), cell: { userEnteredFormat: uef }, fields } };
}
function borders(sheetId, r0, r1, c0, c1) {
  return { updateBorders: { range: R(sheetId, r0, r1, c0, c1), top: border, bottom: border, left: border, right: border, innerHorizontal: border, innerVertical: border } };
}
function freeze(sheetId, n) {
  return { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: n } }, fields: 'gridProperties.frozenRowCount' } };
}
function hidden(sheetId, start, end, value) {
  return { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: end }, properties: { hiddenByUser: value }, fields: 'hiddenByUser' } };
}
function width(sheetId, start, px) {
  return { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: start + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } };
}
function rowHeight(sheetId, idx, px) {
  return { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } };
}
function boldCell(sheetId, r, c) {
  return { repeatCell: { range: R(sheetId, r, r + 1, c, c + 1), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat' } };
}

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());
  const meta = await getMeta(token, id, 'sheets(properties(sheetId,title),conditionalFormats)');
  const byTitle = Object.fromEntries(meta.sheets.map((s) => [s.properties.title, s]));
  const ev = byTitle[EVENTS] || die('Events sheet not found');
  const bal = byTitle[BALANCES] || die('Balances sheet not found');
  const evId = ev.properties.sheetId;
  const balId = bal.properties.sheetId;

  // Events: count data rows (When column A non-empty).
  const evWhen = await valuesGet(token, id, `${EVENTS}!A2:A`);
  const lastEv = 1 + evWhen.filter((r) => r[0] != null && r[0] !== '').length; // 1-based

  // Balances: scan for accounts header + count + currencies, then derive totals rows.
  const balRows = await valuesGet(token, id, `${BALANCES}!A1:F`);
  let hr = -1;
  for (let i = 0; i < balRows.length; i++) if (balRows[i] && String(balRows[i][0]).toLowerCase() === 'id') { hr = i; break; }
  if (hr === -1) die('Balances: accounts header not found');
  const currencies = [];
  let acc = 0;
  for (let i = hr + 1; i < balRows.length; i++) {
    const r = balRows[i];
    if (!r || r[0] == null || r[0] === '') break;
    acc++;
    const c = r[3]; if (c != null && c !== '' && !currencies.includes(String(c))) currencies.push(String(c));
  }
  const headerRow = hr;                 // 0-based row of "id" header
  const dataStart = hr + 1;             // 0-based first account row
  const dataEnd = dataStart + acc;      // 0-based exclusive
  const totalsHeader = dataEnd + 1;     // 0-based "Totals" row
  const totalsStart = totalsHeader + 1; // 0-based first currency row
  const totalsEnd = totalsStart + currencies.length; // exclusive
  console.log(`Events: ${lastEv - 1} rows   Balances: ${acc} accounts, header row ${headerRow + 1}, totals row ${totalsHeader + 1}`);

  const reqs = [];

  // delete existing conditional rules (idempotency)
  for (const s of [ev, bal]) {
    const n = (s.conditionalFormats || []).length;
    for (let i = 0; i < n; i++) reqs.push({ deleteConditionalFormatRule: { sheetId: s.properties.sheetId, index: 0 } });
  }

  // ---- Events ----
  reqs.push(freeze(evId, 1));
  reqs.push(rowHeight(evId, 0, 30));
  reqs.push(header(evId, 0, 0, 7));                       // A1:G1 visible header
  reqs.push(align(evId, 1, 0, 'CENTER'));                 // When
  reqs.push(align(evId, 1, 1, 'CENTER'));                 // Type
  reqs.push(align(evId, 1, 2, 'CENTER'));                 // From
  reqs.push(align(evId, 1, 3, 'CENTER'));                 // To
  reqs.push(align(evId, 1, 4, 'RIGHT', NUMFMT));          // Amount
  reqs.push(align(evId, 1, 5, 'RIGHT', NUMFMT));          // Received
  reqs.push(align(evId, 1, 6, 'LEFT'));                   // Note
  reqs.push(borders(evId, 0, lastEv, 0, 7));              // A1:G{last}
  reqs.push(hidden(evId, 0, 7, false));                   // A..G visible
  reqs.push(hidden(evId, 7, 10, true));                   // id, at, client_id hidden
  const evW = { 0: 130, 1: 80, 2: 120, 3: 120, 4: 95, 5: 95, 6: 240 };
  for (const [c, px] of Object.entries(evW)) reqs.push(width(evId, Number(c), px));
  // amount colored by type (Type=B, Amount=E, Received=F) — open-ended rows
  const cond = (formula, color) => ({
    addConditionalFormatRule: {
      rule: { ranges: [R(evId, 1, null, 4, 6)], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format: { textFormat: { foregroundColor: color, bold: true } } } },
      index: 0,
    },
  });
  reqs.push(cond('=$B2="income"', GREEN));
  reqs.push(cond('=$B2="expense"', RED));

  // ---- Balances ----
  reqs.push(freeze(balId, 0));
  reqs.push(boldCell(balId, 0, 0));                       // A1 "Updated"
  reqs.push(align(balId, 0, 1, 'LEFT'));                  // B1 date (single row via align from row 0)
  reqs.push(header(balId, headerRow, 0, 4));              // accounts header
  // account rows alignment
  reqs.push({ repeatCell: { range: R(balId, dataStart, dataEnd, 0, 1), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)' } });
  reqs.push({ repeatCell: { range: R(balId, dataStart, dataEnd, 1, 2), cell: { userEnteredFormat: { horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)' } });
  reqs.push({ repeatCell: { range: R(balId, dataStart, dataEnd, 2, 3), cell: { userEnteredFormat: { horizontalAlignment: 'RIGHT', verticalAlignment: 'MIDDLE', numberFormat: NUMFMT } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,numberFormat)' } });
  reqs.push({ repeatCell: { range: R(balId, dataStart, dataEnd, 3, 4), cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment)' } });
  // totals block
  reqs.push(boldCell(balId, totalsHeader, 0));           // "Totals"
  reqs.push({ repeatCell: { range: R(balId, totalsStart, totalsEnd, 0, 1), cell: { userEnteredFormat: { horizontalAlignment: 'LEFT', textFormat: { bold: true } } }, fields: 'userEnteredFormat(horizontalAlignment,textFormat)' } });
  reqs.push({ repeatCell: { range: R(balId, totalsStart, totalsEnd, 1, 2), cell: { userEnteredFormat: { horizontalAlignment: 'RIGHT', numberFormat: NUMFMT } }, fields: 'userEnteredFormat(horizontalAlignment,numberFormat)' } });
  // light bg on the Updated + Totals labels
  reqs.push({ repeatCell: { range: R(balId, 0, 1, 0, 2), cell: { userEnteredFormat: { backgroundColor: INFO_BG } }, fields: 'userEnteredFormat.backgroundColor' } });
  // borders
  reqs.push(borders(balId, headerRow, dataEnd, 0, 4));   // accounts table
  reqs.push(borders(balId, 0, 1, 0, 2));                 // Updated box
  reqs.push(borders(balId, totalsHeader, totalsEnd, 0, 2)); // totals box
  // hide raw machinery (E spacer, F raw ISO); ensure A..D visible
  reqs.push(hidden(balId, 0, 4, false));
  reqs.push(hidden(balId, 4, 6, true));
  const balW = { 0: 130, 1: 150, 2: 100, 3: 80 };
  for (const [c, px] of Object.entries(balW)) reqs.push(width(balId, Number(c), px));

  await batchUpdate(token, id, reqs);
  console.log(`✓ formatting applied (${reqs.length} requests)`);
})().catch((e) => die(e.stack || e.message));
