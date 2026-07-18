#!/usr/bin/env node
// Schema migration — reshapes the `Recurring` sheet from the banking-due-date /
// accrued-debt model to the payday-bucket model. See docs/specs/recurring-payday-model.md.
//
//   Was:   A=id B=name C=amount D=currency E=due_day  F=owed        G=last_paid H=next_due I=cycle
//   Now:   A=id B=name C=amount D=currency E=payday   F=paid_amount G=last_paid H=defer_to  I=cycle
//
// G (last_paid) sits at the same column in both layouts — its value is copied
// through unchanged. Everything else is rewritten:
//   - E=payday (5 or 20) from the payday map below, matched by a keyword in `name`.
//   - F=paid_amount reset to 0 — this is also where the accrued `owed` value dies
//     (the T-Bank credit row currently carries 424968 there from the old `accrue`
//     mechanic; it is simply not carried over).
//   - H=defer_to and I=cycle both reset to '' (old H was `next_due`, unrelated
//     field — dropped, not migrated).
//   - C=amount / D=currency overwritten with the norm from the payday map (the
//     sheet's current amount can drift from the norm, e.g. ВТБ 67524 vs 67523).
//
// A brand-new VPS Hetzner row is appended ($10 USD, payday 5) — it has no
// existing row to migrate from.
//
// Every existing payment row MUST match a payday-map entry by name keyword; an
// unmatched row is a data problem, not something to guess at, so the script
// dies with a clear message instead of writing a partial migration.
//
// ⚠️  Run scripts/backup-sheets.mjs FIRST.
//
// DRY_RUN=1 prints the before/after plan (per row: id, name, due_day/owed →
// payday/paid_amount, amount) and exits before any write.
//
// Usage:  node scripts/migrate-payday-model.mjs   (or DRY_RUN=1 node ...)

import {
  loadSA, spreadsheetId, getToken, valuesGet, valuesUpdate, die,
} from './_lib.mjs';

const RECURRING = 'Recurring';
const OLD_HEADER = ['id', 'NAME', 'AMOUNT', 'CURRENCY', 'DUE_DAY', 'OWED', 'LAST_PAID', 'NEXT_DUE', 'CYCLE'];
const NEW_HEADER = ['id', 'NAME', 'AMOUNT', 'CURRENCY', 'PAYDAY', 'PAID_AMOUNT', 'LAST_PAID', 'DEFER_TO', 'CYCLE'];

// --- payday map (contract, docs/specs/recurring-payday-model.md) ---
// Keyed by the matched keyword bucket, not by sheet id (existing ids are kept
// as-is; this map only supplies payday/amount/currency/canonical name).
const PAYDAY_MAP = {
  tbank_platinum: { name: 'Т-Банк кредитка', amount: 15500, currency: 'RUB', payday: 5 },
  alfa: { name: 'Альфа кредитка', amount: 2500, currency: 'RUB', payday: 5 },
  mts: { name: 'МТС кредит', amount: 2768, currency: 'RUB', payday: 5 },
  tbank_loan: { name: 'Т-Банк кредит', amount: 24810, currency: 'RUB', payday: 20 },
  vtb: { name: 'ВТБ кредит', amount: 67523, currency: 'RUB', payday: 20 },
};

// New row with no existing sheet counterpart.
const VPS_HETZNER = {
  id: 'vps_hetzner', name: 'VPS Hetzner', amount: 10, currency: 'USD', payday: 5,
  paid_amount: 0, last_paid: '', defer_to: '', cycle: '',
};

// Match a row's name to a payday-map bucket by keyword. Order matters: the
// "кредитк" (credit card) check must run before the generic "Т-Банк" fallback,
// so "Т-Банк кредитка" doesn't get swallowed by the "Т-Банк кредит" bucket.
function matchBucket(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('втб')) return 'vtb';
  if (n.includes('альфа')) return 'alfa';
  if (n.includes('мтс')) return 'mts';
  if (n.includes('т-банк') || n.includes('тбанк') || n.includes('t-bank')) {
    return n.includes('кредитк') ? 'tbank_platinum' : 'tbank_loan';
  }
  return null;
}

(async () => {
  const id = spreadsheetId();
  const token = await getToken(loadSA());

  const rows = await valuesGet(token, id, `${RECURRING}!A1:I`);
  if (!rows.length) die(`${RECURRING}: sheet is empty`);

  const header = rows[0].map((c) => String(c || '').trim().toUpperCase());
  const expectedOld = OLD_HEADER.map((c) => c.toUpperCase());
  if (header.join('|') !== expectedOld.join('|')) {
    console.log(`⚠ header does not match the expected old layout.`);
    console.log(`  found:    ${header.join(' ')}`);
    console.log(`  expected: ${expectedOld.join(' ')}`);
    console.log(`  proceeding anyway — positional read (A..I), verify the plan below carefully.`);
  }

  const dataRows = rows.slice(1).filter((r) => r && r[0] != null && String(r[0]).trim() !== '');
  if (!dataRows.length) die(`${RECURRING}: no data rows found under the header`);

  const usedBuckets = new Set();
  const migrated = [];

  for (const r of dataRows) {
    const [rid, name, amount, currency, dueDay, owed, lastPaid] = r;
    const bucket = matchBucket(name);
    if (!bucket) {
      die(`row id=${rid} name="${name}" did not match any payday-map bucket (ВТБ / Т-Банк кредитка / Т-Банк кредит / Альфа / МТС) — fix the name or extend the matcher, don't guess.`);
    }
    if (usedBuckets.has(bucket)) {
      die(`row id=${rid} name="${name}" matched bucket "${bucket}" but another row already claimed it — two rows can't map to the same payday-map entry.`);
    }
    usedBuckets.add(bucket);
    const target = PAYDAY_MAP[bucket];

    migrated.push({
      id: rid,
      name: String(name),
      amount: target.amount,
      currency: target.currency,
      payday: target.payday,
      paid_amount: 0,
      last_paid: lastPaid == null ? '' : lastPaid,
      defer_to: '',
      cycle: '',
      _bucket: bucket,
      _old: { dueDay, owed, amount, currency },
    });
  }

  const missing = Object.keys(PAYDAY_MAP).filter((b) => !usedBuckets.has(b));
  if (missing.length) {
    die(`payday-map buckets with no matching sheet row: ${missing.join(', ')} — expected exactly one existing row per bucket (5 credits) plus the new VPS Hetzner row.`);
  }

  migrated.push({ ...VPS_HETZNER, _bucket: 'vps_hetzner', _new: true });

  // --- preview ---
  console.log(`Spreadsheet: ${id}`);
  console.log(`Sheet: ${RECURRING}`);
  console.log(`\nExisting payment rows matched: ${dataRows.length}  |  new rows: 1 (VPS Hetzner)  |  final total: ${migrated.length}`);
  console.log('\nid                  name                  due_day→payday  owed→paid_amount  amount(was→now)  currency');
  for (const m of migrated) {
    if (m._new) {
      console.log(`${m.id.padEnd(20)}${m.name.padEnd(22)}NEW→${String(m.payday).padEnd(11)} —→${String(m.paid_amount).padEnd(16)}  —→${m.amount} (NEW ROW)  ${m.currency}`);
      continue;
    }
    const o = m._old;
    const oldAmountStr = `${o.amount}→${m.amount}`;
    const owedNote = o.owed ? String(o.owed) : '0';
    console.log(`${m.id.padEnd(20)}${m.name.padEnd(22)}${String(o.dueDay ?? '').padEnd(4)}→${String(m.payday).padEnd(8)}  ${owedNote.padEnd(6)}→${String(m.paid_amount).padEnd(11)}  ${oldAmountStr.padEnd(15)}  ${m.currency}`);
    if (o.owed === 424968) console.log(`  ⚠ dropping accrued owed=424968 (old \`accrue\` artifact, not a real debt) — see spec.`);
  }
  console.log('\nColumns H (next_due→defer_to) and I (cycle) reset to \'\' for every existing row.');
  console.log('New header row (E/F/H renamed, rest unchanged):');
  console.log(`  ${NEW_HEADER.join(' | ')}`);

  if (process.env.DRY_RUN) { console.log('\n✓ DRY_RUN — nothing written.'); return; }

  const values = [
    NEW_HEADER,
    ...migrated.map((m) => [m.id, m.name, m.amount, m.currency, m.payday, m.paid_amount, m.last_paid, m.defer_to, m.cycle]),
  ];
  await valuesUpdate(token, id, `${RECURRING}!A1:I${values.length}`, values, 'RAW');
  console.log(`\n✓ ${RECURRING} rewritten: header + ${migrated.length} payment rows (A1:I${values.length}).`);
})().catch((e) => die(e.stack || e.message));
