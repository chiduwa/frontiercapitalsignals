// Tests for scripts/profit-growth.mjs. The research behind every rule is in
// docs/research-2026-09-26/PROFIT_GROWTH.md; these pin the rules to it.
import assert from 'node:assert/strict';
import {
  calendarQuarterIndex, quarterlyFromRecords, companyMetrics, qualifies, isCommonStock, sizeBucket,
  buildLists, medianWeeklyDollarVolume, cohortExcess, summarizeLive, whyItQualifies,
  MIN_WEEKLY_DOLLAR_VOLUME, LIST_SIZE, RANK_BY, PROFIT_GROWTH_EVIDENCE
} from './scripts/profit-growth.mjs';

// ---- calendar quarters, including 52/53-week fiscal years -------------------
assert.equal(calendarQuarterIndex('2024-09-28'), 2024 * 4 + 2, "Apple's Sep-28 quarter is Q3");
assert.equal(calendarQuarterIndex('2024-12-31'), 2024 * 4 + 3);
assert.equal(calendarQuarterIndex('2025-01-03'), 2024 * 4 + 3, 'a quarter ending Jan 3 belongs to Q4 of the prior year');
assert.equal(calendarQuarterIndex('2025-04-05'), 2025 * 4 + 0);

// ---- a missing fourth quarter is derived from the annual figure --------------
// A September fiscal year: its Q4 (Jul-Sep) is never tagged on its own, and it
// sits in the CY..Q3 slot, so label arithmetic would get it wrong.
const apple = [
  { start: '2023-10-01', end: '2023-12-30', val: 33.9 },
  { start: '2023-12-31', end: '2024-03-30', val: 23.6 },
  { start: '2024-03-31', end: '2024-06-29', val: 21.4 },
  { start: '2023-10-01', end: '2024-09-28', val: 93.7 }
];
const q = quarterlyFromRecords(apple);
assert.equal(q.size, 4);
assert.ok(Math.abs(q.get(2024 * 4 + 2).val - (93.7 - 33.9 - 23.6 - 21.4)) < 1e-9, 'Q4 = annual minus the three quarters inside it');
assert.equal(q.get(2024 * 4 + 2).end, '2024-09-28');
assert.equal(quarterlyFromRecords([{ start: '2024-01-01', end: '2024-12-31', val: 10 }]).size, 0,
  'an annual figure with no quarters inside it derives nothing');

// ---- metrics from eight quarters ----------------------------------------------
const mk = (vals, startK = 2024 * 4) => new Map(vals.map((v, i) => [startK + i, { end: `q${i}`, val: v }]));
// oldest first: a year of 10s, then a year of 13-16
const ni = mk([10, 10, 10, 10, 13, 14, 15, 16]);
const rev = mk([100, 100, 100, 100, 120, 120, 120, 120]);
const oi = mk([12, 12, 12, 12, 16, 16, 16, 16]);
const m = companyMetrics({ ni, rev, oi });
assert.equal(m.ttmNi, 58);
assert.equal(m.prevNi, 40);
assert.ok(Math.abs(m.niGrowth - 0.45) < 1e-9);
assert.equal(m.yoyUp, 4);
assert.equal(m.profitableQuarters, 4);
assert.ok(Math.abs(m.revGrowth - 0.2) < 1e-9);
assert.ok(Math.abs(m.oiGrowth - 1 / 3) < 1e-9);
assert.equal(companyMetrics({ ni: mk([1, 2, 3]), rev, oi }), null, 'fewer than eight consecutive quarters sits out');
const gap = new Map(ni); gap.delete(2024 * 4 + 3);
assert.equal(companyMetrics({ ni: gap, rev, oi }), null, 'a missing quarter in the eight sits out rather than being guessed');

// ---- the screen ----------------------------------------------------------------
assert.equal(qualifies(m), true, 'profitable, growing and consistent');
assert.equal(qualifies({ ...m, ttmNi: -1 }), false, 'a net loss is not a profit grower, whatever operating profit did');
assert.equal(qualifies({ ...m, revGrowth: -0.01 }), false, 'profit growth on shrinking revenue does not qualify');
assert.equal(qualifies({ ...m, revGrowth: 3.5 }), false, 'revenue more than quadrupling is treated as an acquisition, not growth');
assert.equal(qualifies({ ...m, yoyUp: 2, oiGrowth: 0.1 }), false, 'neither consistent nor operating growth');
assert.equal(qualifies({ ...m, yoyUp: 1, profitableQuarters: 3, oiTtm: 20, oiPrev: 10, oiGrowth: 1 }), true, 'operating growth alone qualifies');
assert.match(whyItQualifies(m), /operating profit \+33% on revenue \+20%/);
assert.match(whyItQualifies({ ...m, prevNi: -5 }), /net profit turned positive this year/, 'a turnaround is named as one');
assert.equal(isCommonStock('CHS Inc Class B Cumulative Redeemable Preferred Stock'), false);
assert.equal(isCommonStock('Acme Holdings Depositary Shares'), false);
assert.equal(isCommonStock('Apple Inc. Common Stock'), true);
assert.equal(sizeBucket(5e8), 'small');
assert.equal(sizeBucket(5e9), 'mid');
assert.equal(sizeBucket(2e8), 'micro');

// ---- building the lists --------------------------------------------------------
const co = (symbol, mcap, over = {}, extra = {}) => ({ symbol, name: `${symbol} Inc. Common Stock`, sector: 'Technology', price: 20, mcap,
  metrics: { ...m, ...over }, liquidity: 5e6, ...extra });
const companies = [
  co('SLOW', 5e8, { revGrowth: 0.05 }),
  co('FAST', 6e8, { revGrowth: 0.9 }),
  co('LOSS', 7e8, { ttmNi: -5, revGrowth: 1.5 }),
  co('THIN', 8e8, { revGrowth: 1.2 }, { liquidity: 1e6 }),
  co('PENNY', 9e8, { revGrowth: 1.1 }, { price: 1.5 }),
  co('PREF', 9e8, { revGrowth: 1.3 }, { name: 'X Corp Cumulative Preferred' }),
  co('MIDA', 4e9, { oiGrowth: 0.4 }),
  co('MIDB', 5e9, { oiGrowth: 2.5 }),
  co('BIG', 5e10, { revGrowth: 2 })
];
const lists = buildLists(companies);
assert.deepEqual(lists.small.map((r) => r.symbol), ['FAST', 'SLOW'], 'small caps ranked by revenue growth, losses, illiquid, penny and preferred excluded');
assert.deepEqual(lists.mid.map((r) => r.symbol), ['MIDB', 'MIDA'], 'mid caps ranked by operating-profit growth');
assert.equal(lists.small[0].rank, 1);
assert.ok(lists.small[0].why.length > 0 && lists.small[0].pe > 0);
assert.equal(RANK_BY.small, 'revGrowth');
assert.equal(RANK_BY.mid, 'oiGrowth');
const many = Array.from({ length: 40 }, (_, i) => co(`S${i}`, 5e8, { revGrowth: 0.1 + i / 100 }));
assert.equal(buildLists(many).small.length, LIST_SIZE);

// ---- liquidity -------------------------------------------------------------------
const days = [];
for (let d = 0; d < 91; d++) {
  const date = new Date(Date.UTC(2026, 5, 1) + d * 86400000);
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
  days.push({ date: date.toISOString().slice(0, 10), close: 10, volume: 60000 });
}
assert.ok(Math.abs(medianWeeklyDollarVolume(days) - 5 * 10 * 60000) < 1, 'five sessions of $600K is $3M a week');
assert.ok(medianWeeklyDollarVolume(days) >= MIN_WEEKLY_DOLLAR_VOLUME);
assert.equal(medianWeeklyDollarVolume(days.slice(0, 10)), null, 'too little history to judge');

// ---- live scoring ----------------------------------------------------------------
const listRows = Array.from({ length: 6 }, (_, i) => ({ symbol: `L${i}`, price: 10 }));
const bucketRows = Array.from({ length: 30 }, (_, i) => ({ symbol: `B${i}`, price: 10 }));
const priceNow = Object.fromEntries([...listRows.map((r) => [r.symbol, 12]), ...bucketRows.map((r) => [r.symbol, 10.5])]);
const r = cohortExcess(listRows, bucketRows, priceNow);
assert.ok(Math.abs(r.listPct - 20) < 1e-9 && Math.abs(r.bucketPct - 5) < 1e-9 && Math.abs(r.excessPct - 15) < 1e-9);
assert.equal(cohortExcess(listRows.slice(0, 3), bucketRows, priceNow), null, 'too few names to judge');
priceNow.L0 = 100;
assert.ok(cohortExcess(listRows, bucketRows, priceNow).listPct < 70, 'one stock is clipped at +300%, as in the backtest');
const live = summarizeLive([
  { list: 'small', horizon_days: 91, excess_pct: 2 }, { list: 'small', horizon_days: 91, excess_pct: -1 },
  { list: 'mid', horizon_days: 28, excess_pct: 1 }
]);
assert.equal(live['small|91'].cohorts, 2);
assert.ok(Math.abs(live['small|91'].meanExcessPct - 0.5) < 1e-9 && live['small|91'].winShare === 0.5);

// ---- the evidence quoted on the page is the tested one ---------------------------
assert.ok(PROFIT_GROWTH_EVIDENCE.small.perQuarterPct > 0 && PROFIT_GROWTH_EVIDENCE.mid.perQuarterPct > 0);
assert.ok(PROFIT_GROWTH_EVIDENCE.caveats.length >= 3, 'the page carries its caveats');

console.log('PROFIT GROWTH OK');
