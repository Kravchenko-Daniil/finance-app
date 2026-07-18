#!/usr/bin/env node
// Dumps both tabs (raw UNFORMATTED values, full A:Z) to scripts/_backups/ as JSON.
// Run before any migration. Restore = clear the tab and write the saved values back.
//
// Usage:  node scripts/backup-sheets.mjs

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadSA, spreadsheetId, getToken, valuesGet } from './_lib.mjs';

const SHEETS = ['Events', 'Balances', 'Recurring'];

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());
  const dir = path.join(ROOT, 'scripts', '_backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const dump = { spreadsheetId: id, takenAt: new Date().toISOString(), sheets: {} };
  for (const name of SHEETS) {
    const values = await valuesGet(token, id, `${name}!A1:Z`);
    dump.sheets[name] = values;
    console.log(`  ${name}: ${values.length} rows`);
  }

  const file = path.join(dir, `backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  // Also keep a stable "latest" pointer for quick restore.
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(dump, null, 2));
  console.log(`✓ backup written: ${path.relative(ROOT, file)}`);
})();
