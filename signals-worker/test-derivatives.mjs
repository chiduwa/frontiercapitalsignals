// Test suite for the derivatives layer: the portal parser
// (derivatives-archive.mjs) and the feature construction
// (derivatives-features.mjs). Same shape as the other test-*.mjs suites —
// plain assertions, no framework, exits non-zero on failure.
import { deflateRawSync } from 'node:zlib';
import * as A from './scripts/derivatives-archive.mjs';
import * as F from './scripts/derivatives-features.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 1e-6) => a != null && Math.abs(a - b) < eps;

console.log('\n== venue symbol mapping ==');
check('plain symbol gets USDT suffix', A.venueSymbol('ZEC') === 'ZECUSDT');
check('scaled listing uses the 1000x ticker', A.venueSymbol('PEPE') === '1000PEPEUSDT');
check('unmapped symbol does not silently become 1000x', A.venueSymbol('SOL') === 'SOLUSDT');

console.log('\n== zip reader ==');
function makeZip(name, content, { stored = false, streamed = false } = {}) {
  const nameBuf = Buffer.from(name);
  const body = stored ? Buffer.from(content) : deflateRawSync(Buffer.from(content));
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(stored ? 0 : 8, 8);
  h.writeUInt32LE(streamed ? 0 : body.length, 18);
  h.writeUInt32LE(content.length, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBuf, body]);
}
check('reads a deflated entry', A.unzipSingleFile(makeZip('a.csv', 'hello,world')) === 'hello,world');
check('reads a stored (uncompressed) entry', A.unzipSingleFile(makeZip('a.csv', 'plain', { stored: true })) === 'plain');
check('reads a streamed entry with deferred sizes', A.unzipSingleFile(makeZip('a.csv', 'streamed body', { streamed: true })) === 'streamed body');
let threw = false; try { A.unzipSingleFile(Buffer.from('not a zip at all!!')); } catch { threw = true; }
check('rejects non-zip input instead of returning garbage', threw);

console.log('\n== metrics csv aggregation ==');
const HEAD = 'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio';
const csv = [HEAD,
  '2026-09-09 00:05:00,ZECUSDT,100,1000,1.0,2.0,1.5,0.8',
  '2026-09-09 12:00:00,ZECUSDT,120,1400,1.2,2.2,1.7,1.0',
  '2026-09-09 23:55:00,ZECUSDT,110,1200,1.1,2.1,1.6,0.9'].join('\n');
const agg = A.aggregateMetricsCsv(csv, { symbol: 'ZEC', venue: 'ZECUSDT', date: '2026-09-09' });
check('close is the LAST bar of the day, not the max', agg.oi_usd_close === 1200, String(agg.oi_usd_close));
check('mean averages every bar', near(agg.oi_usd_mean, 1200));
check('high/low span the day', agg.oi_usd_high === 1400 && agg.oi_usd_low === 1000);
check('positioning ratios are day means', near(agg.toptrader_position_ls, 2.1) && near(agg.all_account_ls, 1.6));
check('sample count recorded', agg.samples === 3);

const strayDay = [HEAD,
  '2026-09-08 23:55:00,ZECUSDT,999,99999,1,1,1,1',
  '2026-09-09 00:05:00,ZECUSDT,100,1000,1,1,1,1'].join('\n');
const aggStray = A.aggregateMetricsCsv(strayDay, { symbol: 'ZEC', venue: 'ZECUSDT', date: '2026-09-09' });
check('a bar from the neighbouring day is excluded', aggStray.samples === 1 && aggStray.oi_usd_high === 1000, JSON.stringify(aggStray));
check('an empty file aggregates to null, not a zero row', A.aggregateMetricsCsv(HEAD, { symbol: 'X', venue: 'XUSDT', date: '2026-09-09' }) === null);
let threwCol = false;
try { A.aggregateMetricsCsv('a,b\n1,2', { symbol: 'X', venue: 'XUSDT', date: '2026-09-09' }); } catch { threwCol = true; }
check('a csv missing required columns throws rather than writing nulls', threwCol);

console.log('\n== D1 insert shape ==');
check('rows-per-statement respects D1 100-param cap', A.DERIV_ROWS_PER_STATEMENT * A.DERIV_COLUMNS.length <= 100,
  `${A.DERIV_ROWS_PER_STATEMENT} x ${A.DERIV_COLUMNS.length}`);
const ins = A.buildDerivInsert([agg, agg]);
check('multi-row insert binds every column of every row', ins.params.length === A.DERIV_COLUMNS.length * 2);
check('insert upserts rather than failing on re-run', /ON CONFLICT\(symbol, date\) DO UPDATE/.test(ins.sql));
check('dateRange is inclusive at both ends', A.dateRange('2026-01-01', '2026-01-03').join(',') === '2026-01-01,2026-01-02,2026-01-03');

console.log('\n== lookback: dates, never index steps ==');
const s = new Map([['2026-09-01', 100], ['2026-09-02', 110], ['2026-09-08', 150]]);
check('exact hit preferred', F.lookback(s, '2026-09-08', 6).date === '2026-09-02');
check('tolerated near-miss reports its gap', F.lookback(s, '2026-09-08', 8)?.gapDays === 1);
check('beyond tolerance abstains', F.lookback(s, '2026-09-08', 30) === null);
check('pctChange uses real dates', near(F.pctChange(s, '2026-09-08', 6), (150 / 110 - 1) * 100));
check('pctChange abstains across a real gap', F.pctChange(s, '2026-09-08', 30) === null);

console.log('\n== rolling percentile fixes the saturation bug ==');
// A monotonically rising series: the OLD expanding-window percentile pins at
// 1.00 forever. A rolling window must too — but only while the rise continues;
// the point of the test is that a pullback is actually VISIBLE.
const rising = Array.from({ length: 300 }, (_, i) => 100 + i);
check('still at the top while genuinely making highs', near(F.rollingPercentile(rising, 299), 1, 1e-9));
const pulledBack = rising.slice(0, 299).concat([rising[299] - 120]);
const pb = F.rollingPercentile(pulledBack, 299);
check('a pullback moves off 1.00 instead of staying pinned', pb != null && pb < 0.6, String(pb));
check('thin history abstains rather than ranking noise', F.rollingPercentile(rising.slice(0, 30), 29) === null);
check('window is rolling, not expanding', F.OI_PERCENTILE_WINDOW === 252);

console.log('\n== asset features ==');
const dates = A.dateRange('2026-01-01', '2026-04-30');
const rows = dates.map((d, i) => ({
  symbol: 'T', date: d, oi_usd_close: 1000 * (1 + i / 100), oi_usd_mean: 1000 * (1 + i / 100),
  oi_usd_high: 1050 * (1 + i / 100), oi_usd_low: 950 * (1 + i / 100),
  toptrader_position_ls: 2, all_account_ls: 1, taker_buy_sell_ratio: 1
}));
const prices = new Map(dates.map((d) => [d, 50]));   // price deliberately FLAT
const feats = F.assetDerivFeatures(rows, prices);
const last = feats[feats.length - 1];
check('oi_chg_7d computed', last.oi_chg_7d > 0);
check('smart_retail_gap = toptrader / all-account', near(last.smart_retail_gap, 2));
check('OI rising on flat price shows as positive divergence', last.oi_px_divergence > 0 && near(last.px_chg_7d, 0));
check('divergence abstains when price is unknown',
  F.assetDerivFeatures(rows, new Map())[rows.length - 1].oi_px_divergence === null);
check('every declared feature id exists on the output',
  F.DERIV_FEATURE_IDS.every((id) => id in last), F.DERIV_FEATURE_IDS.filter((id) => !(id in last)).join(','));

console.log('\n== market context: universe growth must not fake a signal ==');
const mk = (sym, oi, chg = 1) => ({ symbol: sym, oi_usd: oi, oi_chg_7d: chg, toptrader_position_ls: 1.5 });
const base = Array.from({ length: 25 }, (_, i) => mk(`A${i}`, 10));
const byDate = new Map([
  ['2026-01-01', [mk('BTC', 1000), mk('ETH', 500), ...base]],
  // same real OI, but 25 NEW symbols appear — a schema change, not leverage
  ['2026-01-08', [mk('BTC', 1000), mk('ETH', 500), ...base, ...Array.from({ length: 25 }, (_, i) => mk(`B${i}`, 10))]]
]);
const ctx = F.marketContextSeries(byDate);
check('alt/btc ratio is reported per date', ctx[0].alt_btc_oi_ratio != null);
check('BTC share is a fraction of total', ctx[0].btc_oi_share > 0 && ctx[0].btc_oi_share < 1);
check('ratio > 1 literally means alt OI exceeds BTC OI',
  near(ctx[0].alt_btc_oi_ratio, 250 / 1000) && ctx[0].alt_btc_oi_ratio < 1);
const fixed = F.fixedMembershipOiChange(byDate, '2026-01-08', 7);
check('fixed-membership change ignores the 25 newly-added symbols', near(fixed.pct, 0), JSON.stringify(fixed));
check('fixed-membership change reports which symbols it used', fixed.symbols === 27);
check('thin cross-section abstains', F.marketContextSeries(new Map([['2026-01-01', [mk('BTC', 1)]]]))[0].insufficient === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
