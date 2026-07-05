#!/usr/bin/env node
// One-off operator script: set the primary account/currency on the Settings tab.
// Writes Settings!C3 = primary_account id, Settings!C4 = primary_currency.
//
// Usage:  node scripts/set-primary.mjs
//
// Direct-to-Sheets (operator path) is fine here: Settings holds config, not
// financial rows, so there is no balance recompute to coordinate.

import { loadSA, spreadsheetId, getToken, valuesUpdate } from './_lib.mjs';

const ACCOUNT = 'cash';
const CURRENCY = 'THB';

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());
  await valuesUpdate(token, id, 'Settings!C3:C4', [[ACCOUNT], [CURRENCY]], 'RAW');
  console.log(`✓ Settings!C3='${ACCOUNT}'  Settings!C4='${CURRENCY}'`);
})();
