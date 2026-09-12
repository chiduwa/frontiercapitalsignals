// Test suite for corrupt-bar detection (scripts/bar-quarantine.mjs,
// migration 0034). The cases are drawn from real rows in asset_daily_bars,
// including the ones that must NOT be flagged.
import {
  detectBadBars, buildQuarantineIndex, isQuarantined, spansIdentityChange,
  cleanBars, SPIKE_LOG_THRESHOLD, LEVEL_SHIFT_LOG_THRESHOLD
} from './scripts/bar-quarantine.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const series = (start, closes) => closes.map((c, i) => ({
  date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10), close: c
}));
const flat = (v, n) => Array.from({ length: n }, () => v);
const reasonsAt = (bad, date) => bad.filter((b) => b.date === date).map((b) => b.reason);

console.log('\n== thresholds are split, and in the right direction ==');
check('level-shift bar is stricter than the spike bar', LEVEL_SHIFT_LOG_THRESHOLD > SPIKE_LOG_THRESHOLD,
  `${Math.exp(LEVEL_SHIFT_LOG_THRESHOLD).toFixed(0)}x vs ${Math.exp(SPIKE_LOG_THRESHOLD).toFixed(0)}x`);

console.log('\n== spikes: wrong bar, series reverts ==');
// TIA 2024-03-30: 0.01308 -> 68.25 -> 0.01790
const spike = detectBadBars(series('2024-03-24', [0.0095, 0.0105, 0.0131, 0.0131, 68.25, 0.0179, 0.0172, 0.0155]));
check('a 5000x print that reverts is flagged as a spike', reasonsAt(spike, '2024-03-28').includes('spike'),
  JSON.stringify(spike));
check('the neighbouring good bars are untouched', !spike.some((b) => ['2024-03-29', '2024-03-30'].includes(b.date)));

console.log('\n== level shifts: ticker remapped to a different asset ==');
// APE 2023-07-19: 0.000713 -> 2.064 and HOLDS
const shift = detectBadBars(series('2023-07-14', [
  0.00075, 0.00061, 0.00060, 0.00071, 0.00071, 2.064, 2.146, 2.166, 2.079, 2.110, 2.046, 2.05
]));
check('a jump that holds is a level shift, not a spike', reasonsAt(shift, '2023-07-19').includes('level-shift'),
  JSON.stringify(shift));
check('the boundary is the FIRST bar of the new regime', shift.some((b) => b.date === '2023-07-19' && b.reason === 'level-shift'));

console.log('\n== the false positive this threshold exists to avoid ==');
// DOGE 2021-01-28 rose 4.43x in a day, and it was real.
const doge = detectBadBars(series('2021-01-24', [
  0.0076, 0.0080, 0.0082, 0.0084, 0.0372, 0.0360, 0.0310, 0.0290, 0.0280, 0.0270, 0.0265, 0.0260
]));
check('a real 4.43x market move is NOT quarantined', !doge.some((b) => b.reason === 'level-shift'),
  JSON.stringify(doge.filter((b) => b.reason !== 'stale')));

console.log('\n== stale feeds ==');
const stale = detectBadBars(series('2025-12-01', flat(0.000003, 14).concat([0.000004, 0.000005])));
check('a 14-bar unchanged run is flagged stale', stale.filter((b) => b.reason === 'stale').length === 14,
  String(stale.filter((b) => b.reason === 'stale').length));
check('a short unchanged run is not', !detectBadBars(series('2025-12-01', flat(1, 4).concat([2, 3]))).some((b) => b.reason === 'stale'));
check('a normal series is clean', detectBadBars(series('2025-01-01', [10, 10.4, 10.1, 10.9, 11.3, 10.8, 11.1, 11.6])).length === 0);

console.log('\n== one verdict per date, most severe wins ==');
const both = detectBadBars(series('2025-01-01', flat(0.001, 12).concat([50, 51, 52, 51, 50, 49, 51])));
const dates = both.map((b) => b.date);
check('no date appears twice', new Set(dates).size === dates.length);

console.log('\n== consumer helpers ==');
const index = buildQuarantineIndex([
  { symbol: 'APE', date: '2023-07-19', reason: 'level-shift' },
  { symbol: 'TIA', date: '2024-03-28', reason: 'spike' }
]);
check('isQuarantined finds a flagged bar', isQuarantined(index, 'TIA', '2024-03-28'));
check('isQuarantined leaves a clean bar alone', !isQuarantined(index, 'TIA', '2024-03-27'));
check('a window straddling an identity change is rejected', spansIdentityChange(index, 'APE', '2023-07-12', '2023-07-25'));
check('a window entirely after it is fine', !spansIdentityChange(index, 'APE', '2023-07-19', '2023-07-25'));
check('a window entirely before it does not span it', !spansIdentityChange(index, 'APE', '2023-07-10', '2023-07-15'));
check('the boundary bar itself is NOT treated as a bad price', !isQuarantined(index, 'APE', '2023-07-19'));
check('a symbol with no boundary never spans one', !spansIdentityChange(index, 'BTC', '2020-01-01', '2026-01-01'));

const cleaned = cleanBars(index, 'APE', series('2023-07-16', [0.0006, 0.00071, 0.00071, 2.064, 2.146, 2.166]));
check('cleanBars drops everything before the identity change', cleaned.length === 3 && cleaned[0].date === '2023-07-19',
  JSON.stringify(cleaned.map((b) => b.date)));
const cleanedSpike = cleanBars(index, 'TIA', series('2024-03-27', [0.0131, 68.25, 0.0179]));
check('cleanBars drops a spike bar but keeps its neighbours', cleanedSpike.length === 2
  && !cleanedSpike.some((b) => b.date === '2024-03-28'), JSON.stringify(cleanedSpike.map((b) => b.date)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
