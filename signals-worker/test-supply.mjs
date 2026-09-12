// Test suite for supply/dilution features (scripts/supply-features.mjs,
// migration 0035).
import {
  supplyGrowth, lookbackSupply, assetSupplyFeatures,
  SUPPLY_FEATURE_FAMILY, SUPPLY_SNAPSHOT_FEATURES, SUPPLY_MIN_WINDOW_DAYS
} from './scripts/supply-features.mjs';
import { buildSupplyLookup } from './scripts/fundamentals-panel.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b, eps = 1e-6) => a != null && Math.abs(a - b) < eps;
const days = (start, n) => Array.from({ length: n }, (_, i) =>
  new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

console.log('\n== supply growth uses real dates ==');
const dates = days('2026-01-01', 200);
// 0.1% dilution per day, compounding
const rows = dates.map((d, i) => ({ symbol: 'T', date: d, circulating_supply: 1e9 * Math.pow(1.001, i) }));
const series = new Map(rows.map((r) => [r.date, r.circulating_supply]));
check('30-day growth matches the compounding rate', near(supplyGrowth(series, dates[100], 30), (Math.pow(1.001, 30) - 1) * 100, 1e-9));
check('90-day growth is larger than 30-day for steady dilution', supplyGrowth(series, dates[100], 90) > supplyGrowth(series, dates[100], 30));
check('abstains when the lookback predates the series', supplyGrowth(series, dates[5], 90) === null);
check('tolerates a small gap', lookbackSupply(new Map([['2026-03-01', 5]]), '2026-03-31', 30) === 5);
check('rejects a gap beyond tolerance', lookbackSupply(new Map([['2026-02-20', 5]]), '2026-03-31', 30) === null);
check('shortest window is 30d, because daily diffs are derivation noise', SUPPLY_MIN_WINDOW_DAYS === 30);

console.log('\n== overhang: the "more supply coming" signal ==');
// APT measured live 2026-09-12: circ 858.8M, total 1208.6M -> 40.7%
const apt = assetSupplyFeatures(rows.slice(0, 5),
  { circulating_supply: 858835533, total_supply: 1208585457, max_supply: 2100000000 });
check('overhang = (total - circulating) / circulating', near(apt[0].supply_overhang, 40.723, 0.01), String(apt[0].supply_overhang));
check('pct_of_max reported', near(apt[0].supply_pct_of_max, 40.897, 0.01), String(apt[0].supply_pct_of_max));
const noTotal = assetSupplyFeatures(rows.slice(0, 3), { circulating_supply: 1, total_supply: null, max_supply: null });
check('abstains when total supply is unknown', noTotal[0].supply_overhang === null && noTotal[0].supply_pct_of_max === null);
check('no snapshot at all abstains rather than throwing', assetSupplyFeatures(rows.slice(0, 3), null)[0].supply_overhang === null);

console.log('\n== a snapshot must never be differenced ==');
const feats = assetSupplyFeatures(rows, { circulating_supply: 100, total_supply: 300, max_supply: 1000 });
const overhangs = new Set(feats.map((f) => f.supply_overhang));
check('overhang is constant across every date (it is point-in-time)', overhangs.size === 1, `${overhangs.size} distinct values`);
check('snapshot features are declared as such', SUPPLY_SNAPSHOT_FEATURES.has('supply_overhang') && SUPPLY_SNAPSHOT_FEATURES.has('supply_pct_of_max'));
check('realized dilution is NOT marked as a snapshot', !SUPPLY_SNAPSHOT_FEATURES.has('supply_growth_30d'));

console.log('\n== acceleration ==');
// Flat supply: no dilution, no acceleration.
const flatRows = dates.map((d) => ({ symbol: 'F', date: d, circulating_supply: 1e9 }));
const flatFeats = assetSupplyFeatures(flatRows, null);
check('flat supply reports zero growth', near(flatFeats[150].supply_growth_30d, 0));
check('flat supply reports zero acceleration', near(flatFeats[150].supply_accel, 0));
check('steady dilution has near-zero acceleration', Math.abs(feats[150].supply_accel) < 0.2, String(feats[150].supply_accel));

console.log('\n== feature surface ==');
check('every declared feature exists on the output',
  SUPPLY_FEATURE_FAMILY.every((id) => id in feats[0]),
  SUPPLY_FEATURE_FAMILY.filter((id) => !(id in feats[0])).join(','));
check('a symbol with no history yields no rows', assetSupplyFeatures([], null).length === 0);

// ---------------------------------------------------------------------------
// The panel the PRODUCTION fit actually reads. supply-features.mjs above is the
// research harness; buildSupplyLookup is what reaches XS_FEATURES, and until
// 2026-09-12 it was pointed at a table holding a single date while a year of
// history sat unread in another one.
console.log('\n== fundamentals panel: both supply sources are read, and kept apart ==');
const iso = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10);
const dailyRows = [];
for (let k = 0; k < 200; k++) dailyRows.push({ symbol: 'T', date: iso(k), circulating_supply: 1000 + k * 10 });
// One snapshot date, which is the real shape of asset_supply_snapshot_daily on
// the day this was written.
const snapRows = [{ symbol: 'T', date: iso(199), circulating_supply: 2990, total_supply: 5000, max_supply: 10000 }];

const panel = buildSupplyLookup(snapRows, dailyRows);
const at199 = panel.get('T').get(iso(199));
check('a 30-day float change is produced from the deep daily series, not the one-date snapshot',
  at199.supply_change_30d != null && at199.supply_change_30d > 0, String(at199.supply_change_30d));
check('the point-in-time ratios still come from the snapshot',
  Math.abs(at199.float_ratio - 2990 / 5000) < 1e-9 && Math.abs(at199.supply_pct_of_max - 29.9) < 1e-9);
check('total-supply differences stay null while the snapshot has only one date, rather than being faked',
  at199.burn_rate_30d === null && at199.lockup_rate_30d === null);
check('a date the snapshot has never seen still gets its differenced float feature',
  panel.get('T').get(iso(120)).supply_change_30d != null);
check('that same date reports no snapshot-only ratio rather than borrowing a later reading',
  panel.get('T').get(iso(120)).float_ratio === null);

// The seam guard: the snapshot's reported circulating (2990) sits below the
// derived series' value for the same date (2990 vs 1000+199*10=2990 here by
// construction, so perturb it) and must never enter the differenced series.
const skewedSnap = [{ symbol: 'T', date: iso(199), circulating_supply: 9999, total_supply: 50000, max_supply: 100000 }];
const skewed = buildSupplyLookup(skewedSnap, dailyRows);
check('a divergent snapshot reading cannot contaminate the differenced series (no fabricated unlock at the seam)',
  Math.abs(skewed.get('T').get(iso(199)).supply_change_30d - at199.supply_change_30d) < 1e-9,
  `${skewed.get('T').get(iso(199)).supply_change_30d} vs ${at199.supply_change_30d}`);

check('a symbol present only in the daily series still yields features',
  buildSupplyLookup([], dailyRows).get('T').get(iso(199)).supply_change_30d != null);
check('a symbol present only in the snapshot yields ratios and no differences',
  (() => { const p = buildSupplyLookup(snapRows, []).get('T').get(iso(199)); return p.float_ratio != null && p.supply_change_30d === null; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
