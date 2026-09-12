// Test suite for supply/dilution features (scripts/supply-features.mjs,
// migration 0035).
import {
  supplyGrowth, lookbackSupply, assetSupplyFeatures,
  SUPPLY_FEATURE_FAMILY, SUPPLY_SNAPSHOT_FEATURES, SUPPLY_MIN_WINDOW_DAYS
} from './scripts/supply-features.mjs';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
