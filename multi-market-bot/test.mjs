import test from 'node:test';
import assert from 'node:assert/strict';
import { indicators, signalAt, sizeLong, validateSeries } from './src/strategies.mjs';
import { replay, researchReport } from './src/replay.mjs';
import { normalizeYahoo } from './src/data.mjs';

const hour = 3_600_000, epoch = Date.UTC(2026, 0, 1);
const bars = (n = 60) => Array.from({ length: n }, (_, i) => ({ at: epoch + i * hour,
  end: epoch + (i + 1) * hour, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
const series = b => ({ symbol: 'BTC/USD', timeframe: '1h', source: 'synthetic-test-only', bars: b });
const breakout = () => {
  const b = bars();
  b[21] = { ...b[21], close: 104, high: 105, volume: 200 };
  b[22] = { ...b[22], open: 104, close: 104, high: 106, low: 103 };
  return b;
};
const run = b => replay(series(b), { asOf: b.at(-1).end, startAt: b[21].at });

test('breakout channel excludes the triggering candle', () => {
  const b = breakout(), s = indicators(b);
  assert.equal(s[21].priorHigh, 101);
  assert.equal(signalAt('BTC/USD', b, s, 21).enter, true);
  b[21].volume = 149;
  assert.equal(signalAt('BTC/USD', b, indicators(b), 21).enter, false);
});
test('signals and indicators cannot see future candles', () => {
  const b = breakout();
  const a = indicators(b.slice(0, 22)), all = indicators(b);
  assert.deepEqual(a, all.slice(0, 22));
  assert.deepEqual(signalAt('BTC/USD', b, all, 21), signalAt('BTC/USD', b.slice(0, 22), a, 21));
});
test('flat history abstains, trend waits for full EMA warmup', () => {
  const b = bars(240), s = indicators(b);
  assert.equal(signalAt('SPY', b, s, 21).enter, false);
  assert.equal(signalAt('GLD', b, s, 198).reason, 'ema-warmup');
  assert.equal(signalAt('GLD', b, s, 201).enter, false);
});
test('trend requires a new cross, not merely an existing trend', () => {
  const b = bars(450).map((b, i) => {
    const close = i < 250 ? 150 - i * 0.1 : 125 + (i - 250) * 0.5;
    return { ...b, open: close, close, low: close - 1, high: close + 1 };
  });
  const s = indicators(b), entries = b.map((_, i) => signalAt('GLD', b, s, i)).filter(s => s.enter);
  assert.equal(entries.length, 1);
  assert.equal(signalAt('GLD', b, s, b.length - 1).enter, false);
});
test('sizing budgets actual stop and both sides of costs', () => {
  const args = { equity: 10_000, cash: 10_000, entry: 100, stop: 94, feeBps: 25, slippageBps: 5 };
  const q = sizeLong(args), stopFill = 94 * 0.9995;
  assert.ok(Math.abs(q * (100 - stopFill + (100 + stopFill) * 0.0025) - 100) < 1e-9);
  assert.ok(q < 100 / 6);
  assert.equal(sizeLong({ ...args, riskFraction: 0.02 }), 0);
  assert.equal(sizeLong({ ...args, stop: 101 }), 0);
});
test('cash caps exposure, zero/NaN inputs cannot generate orders', () => {
  const args = { equity: 10_000, cash: 10, entry: 100, stop: 99, feeBps: 25, slippageBps: 5 };
  assert.ok(sizeLong(args) * 100 * 1.0025 <= 10 + 1e-12);
  assert.equal(sizeLong({ ...args, equity: NaN }), 0);
  assert.equal(sizeLong({ ...args, cash: 0 }), 0);
});
test('entry happens next open and adverse gaps fill through the stop', () => {
  const b = breakout();
  b[23] = { ...b[23], open: 90, close: 90, low: 89, high: 91 };
  const r = run(b), t = r.trades[0];
  assert.equal(t.entryAt, b[22].at);
  assert.equal(t.signalAt, b[21].end);
  assert.equal(t.entry, 104 * 1.0005);
  assert.equal(t.reason, 'gap-stop');
  assert.equal(t.exit, 90 * 0.9995);
  assert.ok(t.netPnl < -100); // 1% is not a gap loss guarantee.
  assert.ok(Math.abs(r.finalEquity - 10_000 - r.trades.reduce((s, t) => s + t.netPnl, 0)) < 1e-8);
  assert.equal(r.liveEligible, false);
});
test('intrabar high cannot retroactively tighten a stop', () => {
  const b = breakout();
  b[22] = { ...b[22], high: 200, low: 102, close: 104 };
  b[23] = { ...b[23], open: 104, low: 103, close: 104, high: 105 };
  const t = run(b).trades[0];
  assert.ok(t.exitAt > b[22].end);
  assert.ok(t.stop >= t.initialStop);
});
test('drawdown halt stays latched even when new breakouts appear', () => {
  const b = breakout();
  b[23] = { ...b[23], open: 1, close: 1, high: 2, low: 0.5 };
  b[45] = { ...b[45], close: 110, high: 111, volume: 300 };
  assert.equal(signalAt('BTC/USD', b, indicators(b), 45).enter, true);
  const r = run(b);
  assert.equal(r.halted, true);
  assert.ok(r.maxDrawdownPct > 10);
  assert.equal(r.tradeCount, 1);
});
test('mean reversion enters below threshold and exits at the mean', () => {
  const b = bars();
  b[21] = { ...b[21], close: 95, low: 94 };
  const s = indicators(b);
  assert.equal(signalAt('SPY', b, s, 21).enter, true);
  assert.equal(signalAt('SPY', b, s, 22).exit, true);
});
test('chronological report resets accounts and does not carry positions across split', () => {
  const input = { version: 1, asOf: epoch + 501 * 4 * hour,
    series: ['SPY', 'QQQ', 'BTC/USD', 'GLD', 'USO'].map(symbol => {
      const duration = ['SPY', 'QQQ'].includes(symbol) ? 900_000 : symbol === 'BTC/USD' ? hour : 4 * hour;
      const timeframe = duration === 900_000 ? '15m' : duration === hour ? '1h' : '4h-session';
      const b = bars(500).map((b, i) => ({ ...b, at: epoch + i * duration, end: epoch + (i + 1) * duration }));
      return { symbol, timeframe, source: 'synthetic-test-only', bars: b };
    }) };
  const r = researchReport(input);
  assert.equal(r.liveEligible, false);
  for (const s of r.results) {
    assert.ok(s.earlySample.endAt <= s.cutoffAt);
    assert.ok(s.laterSample.startAt >= s.cutoffAt);
    assert.equal(s.laterSample.initialEquity, 10_000);
    assert.equal(s.laterSample.tradeCount, 0);
    assert.equal(s.laterSample.finalEquity, 10_000);
  }
});
test('unfinished, missing, duplicate, malformed and wrong-timeframe data rejected', () => {
  const b = bars();
  assert.throws(() => validateSeries(series(b), b.at(-1).at), /unfinished/);
  assert.throws(() => validateSeries(series(b.filter((_, i) => i !== 30)), b.at(-1).end), /Missing/);
  assert.throws(() => validateSeries(series([...b, b.at(-1)]), b.at(-1).end), /unordered/);
  assert.throws(() => validateSeries(series(b.map((x, i) => i === 4 ? { ...x, low: 200 } : x)), b.at(-1).end), /Invalid/);
  assert.throws(() => validateSeries({ ...series(b), timeframe: '15m' }, b.at(-1).end), /metadata/);
  assert.throws(() => researchReport({ version: 1, series: [series(b)] }), /five/);
});
test('warmup and date boundaries enforced', () => {
  const b = bars();
  assert.throws(() => replay(series(b), { asOf: b.at(-1).end, startAt: b[0].at }), /warmup/);
  assert.throws(() => replay(series(b), { asOf: b.at(-1).end, startAt: NaN }), /settings/);
  assert.throws(() => replay(series(b), { asOf: b.at(-1).end, startAt: b[21].at, slippageBps: -1 }), /settings/);
});

function yahooSessions(starts, interval = hour) {
  const timestamp = starts.flatMap(start => Array.from({ length: interval === hour ? 7 : 26 }, (_, i) => (start + i * interval) / 1000));
  return { chart: { result: [{ meta: { symbol: interval === hour ? 'GLD' : 'SPY',
    exchangeTimezoneName: 'America/New_York', dataGranularity: interval === hour ? '1h' : '15m' },
  timestamp, indicators: { quote: [{ open: timestamp.map(() => 100), close: timestamp.map(() => 101),
    high: timestamp.map(() => 102), low: timestamp.map(() => 99), volume: timestamp.map(() => 1) }] } }] } };
}
test('4h aggregation respects NY daylight time and 2.5h session tail', () => {
  const starts = Array.from({ length: 11 }, (_, i) => Date.UTC(2026, 2, 9 + i, 13, 30));
  const r = normalizeYahoo('GLD', yahooSessions(starts), Date.UTC(2026, 3, 1));
  assert.equal(r.bars.length, 22);
  assert.equal(r.bars[0].end - r.bars[0].at, 4 * hour);
  assert.equal(r.bars[1].end - r.bars[1].at, 2.5 * hour);
  assert.equal(r.bars[0].volume, 4);
  const winter = starts.map(t => t - 60 * 86_400_000 + hour);
  assert.equal(normalizeYahoo('GLD', yahooSessions(winter), Date.UTC(2026, 3, 1)).bars.length, 22);
});
test('incomplete equity sessions recorded, wrong provider identity rejected', () => {
  const starts = Array.from({ length: 3 }, (_, i) => Date.UTC(2026, 2, 9 + i, 13, 30));
  const j = yahooSessions(starts, 900_000), r = j.chart.result[0];
  r.indicators.quote[0].low[30] = null;
  const output = normalizeYahoo('SPY', j, Date.UTC(2026, 3, 1));
  assert.equal(output.dataQuality.omittedSessions, 1);
  assert.equal(output.bars.length, 26);
  assert.equal(output.dataQuality.discardedPrefixBars, 26);
  r.meta.symbol = 'QQQ';
  assert.throws(() => normalizeYahoo('SPY', j, Date.UTC(2026, 3, 1)), /instrument/);
});
