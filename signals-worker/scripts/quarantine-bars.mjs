// Scans asset_daily_bars for corrupt rows and records them in
// asset_bar_quarantine (migration 0034). Idempotent: re-running replaces this
// detector version's verdicts rather than accumulating duplicates.
//
// Default is a DRY RUN that prints what it would write. Pass --apply to
// persist. That default is deliberate — this table shapes what every other
// lane is allowed to trade, so a threshold change should be read before it is
// committed.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { detectBadBars } from './bar-quarantine.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

export const DETECTOR_VERSION = 'bar-quarantine-v1';
const APPLY = process.argv.includes('--apply');
// Stale runs are recorded but are the low-severity class; skipping them keeps
// the table to the ~41 rows that represent actual corruption when a caller
// only wants the hard set.
const INCLUDE_STALE = !process.argv.includes('--no-stale');

async function main() {
  const now = new Date().toISOString();
  let total = 0;
  const counts = { spike: 0, 'level-shift': 0, stale: 0 };
  const pending = [];

  for (const assetClass of ['crypto', 'stock']) {
    const bars = await d1(env,
      'SELECT symbol, date, close FROM asset_daily_bars WHERE asset_class = ? ORDER BY symbol, date',
      [assetClass]);
    const bySymbol = new Map();
    for (const b of bars) {
      if (!bySymbol.has(b.symbol)) bySymbol.set(b.symbol, []);
      bySymbol.get(b.symbol).push(b);
    }
    let classCount = 0;
    for (const [symbol, rows] of bySymbol) {
      for (const bad of detectBadBars(rows)) {
        if (bad.reason === 'stale' && !INCLUDE_STALE) continue;
        counts[bad.reason]++;
        classCount++;
        pending.push([assetClass, symbol, bad.date, bad.reason, bad.detail, DETECTOR_VERSION, now]);
      }
    }
    console.log(`${assetClass}: ${bars.length} bars / ${bySymbol.size} symbols -> ${classCount} flagged`);
    total += classCount;
  }

  console.log(`\ntotals: spike=${counts.spike} level-shift=${counts['level-shift']} stale=${counts.stale} (${total} rows)`);
  const hard = counts.spike + counts['level-shift'];
  console.log(`hard corruption (spike + level-shift): ${hard} rows`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.');
    for (const p of pending.filter((x) => x[3] !== 'stale').slice(0, 20)) {
      console.log(`  ${p[0].padEnd(6)} ${p[1].padEnd(10)} ${p[2]}  ${p[3].padEnd(12)} ${p[4]}`);
    }
    return;
  }

  // Replace this detector version's previous verdicts wholesale: a threshold
  // change must be able to REMOVE a flag, not only add one.
  await d1(env, 'DELETE FROM asset_bar_quarantine WHERE detector_version = ?', [DETECTOR_VERSION]);
  const cols = '(asset_class, symbol, date, reason, detail, detector_version, detected_at)';
  // D1 caps bound params at 100 per statement: 7 columns -> 14 rows.
  const statements = chunk(pending, 14).map((group) => ({
    sql: `INSERT OR REPLACE INTO asset_bar_quarantine ${cols} VALUES `
      + group.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', '),
    params: group.flat()
  }));
  for (const batch of chunk(statements, 40)) await d1Batch(env, batch);
  const check = await d1(env, 'SELECT reason, COUNT(*) n FROM asset_bar_quarantine GROUP BY reason');
  console.log('\nwritten. table now holds:', check.map((r) => `${r.reason}=${r.n}`).join(' '));
}

main().catch((e) => { console.error(e); process.exit(1); });
