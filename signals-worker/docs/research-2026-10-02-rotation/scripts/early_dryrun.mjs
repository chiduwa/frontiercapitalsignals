// Dry run of the early pass, read-only: the archive as it stood before Signals
// Daily wrote 2026-10-01 (rows <= 2026-09-30), the clock at 2026-10-02T00:21Z.
// Compares the in-memory 10-01 closes with what Signals Daily archived later.
import { writeFile } from 'node:fs/promises';
import { readAllDailyBars, d1 } from '../../../scripts/d1-client.mjs';
import { topUpLatestDay, buildSeries } from '../../../scripts/big-move-watch-io.mjs';
// Read-only. Any D1-read credential: the workflows' CLOUDFLARE_API_TOKEN, or wrangler's OAuth token from `wrangler login`.
const env = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CF_OAUTH, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID };
const all = await readAllDailyBars(env, 'symbol, date, close, high, low, volume, source', { symbolWhere: "asset_class = 'crypto'", extraWhere: "asset_class = 'crypto'" });
const actual = new Map(all.filter(r => r.date === '2026-10-01').map(r => [r.symbol, r]));
const before = all.filter(r => r.date <= '2026-09-30');
const t0 = Date.now();
const { rows, meta } = await topUpLatestDay(before, { nowMs: Date.parse('2026-10-02T00:21:00Z') });
console.log(`archive rows ${all.length}; early pass: target ${meta.target}, eligible ${meta.eligible}, topped up ${meta.toppedUp}, skipped ${meta.skipped.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (meta.skipped.length) console.log('skipped:', meta.skipped.slice(0, 12).join('; '));
const added = rows.slice(before.length);
let same = 0, diffs = [];
for (const r of added) {
  const a = actual.get(r.symbol);
  if (!a) { diffs.push(`${r.symbol}: not archived`); continue; }
  const g = Math.abs(r.close / a.close - 1);
  if (g < 1e-9 && a.source === r.source) same++; else diffs.push(`${r.symbol} ${r.source}->${a.source} close ${r.close} vs ${a.close} (${(g * 100).toFixed(3)}%) vol ${r.volume} vs ${a.volume}`);
}
console.log(`identical to the later archive row: ${same} of ${added.length}`);
if (diffs.length) console.log('differences:\n  ' + diffs.slice(0, 20).join('\n  '));
const quarantine = await d1(env, "SELECT symbol, date FROM asset_bar_quarantine WHERE asset_class = 'crypto'");
await writeFile(process.argv[2], JSON.stringify(buildSeries(rows, quarantine)));
await writeFile(process.argv[3], JSON.stringify(meta));
// and the archive-backed series the 09:36 run used, for the comparison
await writeFile(process.argv[4], JSON.stringify(buildSeries(all.filter(r => r.date <= '2026-10-01'), quarantine)));
