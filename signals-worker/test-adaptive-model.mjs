import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { walkForwardAsset, createAdaptiveRegressor, featuresAt, alignedBenchmarkStats, validateBars, FEATURE_NAMES } from './scripts/adaptive-model.mjs';
import { buildAdaptiveReport, persistAdaptiveReport, loadAdaptiveHealth, loadAdaptivePanel } from './scripts/adaptive-research.mjs';
import { completedDailyBars, needsDailyRefresh, selectArchiveUpdates } from './scripts/archive-policy.mjs';
import { datedBenchmarkCorrelation, yahooCryptoDailyHistory } from './worker.js';
import { replayMetrics } from './scripts/replay-metrics.mjs';
import { loadReliability } from './scripts/reliability.mjs';

const date = i => new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10);
function series(n = 600) {
  let price = 100, prior = 0.01, state = 173;
  return Array.from({ length: n }, (_, i) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    prior = -0.75 * prior + (state / 2 ** 32 - 0.5) * 0.01;
    price *= Math.exp(prior);
    return { date: date(i), close: price, volume: 1000 + (state % 1000) };
  });
}

test('daily archive admits completed, valid bars and refreshes yesterday instead of waiting three days', () => {
  const now = Date.parse('2026-09-14T02:37:00Z');
  assert.equal(needsDailyRefresh({ count: 1000, maxDate: '2026-09-12' }, now), true);
  assert.equal(needsDailyRefresh({ count: 1000, maxDate: '2026-09-13' }, now), false);
  const bars = [{ date: '2026-09-13', close: 100 }, { date: '2026-09-14', close: 101 }, { date: '2026-09-12', close: NaN }];
  assert.deepEqual(completedDailyBars(bars, now), bars.slice(0, 1));
});

test('archive budget prioritizes current data and repairs interior gaps without rewriting existing bars', () => {
  const bars = series(100), now = Date.parse(date(101));
  const coverage = { count: 99, minDate: date(0), maxDate: date(95), existingDates: bars.slice(0, 96).filter((_, i) => i !== 80).map(b => b.date) };
  assert.deepEqual(selectArchiveUpdates(bars, coverage, 3, { nowMs: now }).map(b => b.date), [99, 98, 97].map(date));
  assert.deepEqual(selectArchiveUpdates(bars, coverage, 20, { nowMs: now }).map(b => b.date), [99, 98, 97, 96, 80].map(date));
  assert.equal(selectArchiveUpdates(bars, coverage, 0, { nowMs: now }).length, 0);
});

test('correlations match both start and end dates across holes', () => {
  const bench = series(100), asset = bench.filter((_, i) => i % 3 !== 0);
  assert.ok(Math.abs(alignedBenchmarkStats(asset, bench).correlation - 1) < 1e-10);
  assert.equal(alignedBenchmarkStats(asset.slice(0, 10), bench), null);
  assert.ok(Math.abs(datedBenchmarkCorrelation(asset, bench) - 1) < 1e-10);
});

test('the original replay uses calendar alignment even when a benchmark includes future bars', () => {
  const bench = series(400), bars = bench.filter((_, i) => i % 17 !== 0);
  const i = 300;
  const metrics = replayMetrics('T', bars, i, { benchBars: bench });
  assert.ok(Math.abs(metrics.corr - 1) < 1e-10);
});

test('Yahoo missing quotes cannot shift dates attached to later closes', async () => {
  const realFetch = globalThis.fetch;
  const bars = series(100);
  globalThis.fetch = async () => Response.json({ chart: { result: [{
    timestamp: bars.map(b => Date.parse(b.date) / 1000),
    indicators: { quote: [{ close: bars.map((b, i) => i === 50 ? null : b.close),
      open: bars.map(b => b.close), high: bars.map(b => b.close), low: bars.map(b => b.close), volume: bars.map(b => b.volume) }] },
    meta: { regularMarketPrice: bars.at(-1).close }
  }] } });
  try {
    const result = await yahooCryptoDailyHistory('T', bars.at(-1).close, 100, Date.parse(date(100)));
    assert.equal(result.bars[50].date, bars[51].date);
    assert.equal(result.bars.at(-1).date, bars.at(-1).date);
  } finally { globalThis.fetch = realFetch; }
});

test('invalid, duplicate, unfinished and stale input cannot become a fresh forecast', () => {
  const bars = series(200);
  const bad = [...bars, bars[0], { date: '2023-02-30', close: 10 }, { date: date(200), close: -1 }];
  const clean = validateBars(bad, { asOf: date(199) });
  assert.equal(clean.quality.duplicate, 1);
  assert.equal(clean.quality.invalid, 2);
  assert.equal(clean.quality.incomplete, 1);
  assert.equal(walkForwardAsset(bars, { symbol: 'T', asOf: date(210) }).forecast, null);
  assert.equal(walkForwardAsset([], { symbol: 'T', asOf: date(210) }).forecast, null);
  const missing = bars.filter((_, i) => i !== 185);
  assert.equal(walkForwardAsset(missing, { symbol: 'T', asOf: date(200) }).forecast, null);
});

test('future prices and benchmarks cannot alter forecasts at an earlier cutoff', () => {
  const bars = series(), cutoff = 400;
  const opts = { symbol: 'T', horizon: 7, asOf: date(cutoff), benchmark: bars };
  const before = walkForwardAsset(bars, opts);
  const mutated = bars.map((b, i) => i >= cutoff ? { ...b, close: b.close * 10000, volume: 1e12 } : b);
  assert.deepEqual(walkForwardAsset(mutated, { ...opts, benchmark: mutated }), before);
  assert.ok(before.forecast.trainedThrough < before.forecast.asOf);
  for (let i = 1; i < before.outcomes.length; i++) {
    assert.ok(before.outcomes[i].asOf >= before.outcomes[i - 1].targetDate);
  }
});

test('ridge learns a real synthetic pattern and calibrated residuals remain out of sample', () => {
  const bars = series(900);
  const result = walkForwardAsset(bars, { symbol: 'T', asOf: date(900), benchmark: bars });
  assert.ok(result.metrics.observations > 700);
  assert.ok(result.metrics.meanAbsoluteErrorPct < result.metrics.zeroForecastErrorPct * 0.9);
  assert.ok(result.forecast.coefficients.return1 < 0);
  assert.ok(result.forecast.interval.lowerPct <= result.forecast.expectedReturnPct);
  assert.ok(result.forecast.interval.upperPct >= result.forecast.expectedReturnPct);
  assert.equal(result.forecast.actionable, false);
  assert.ok(result.metrics.intervalCoverage > 0.65 && result.metrics.intervalCoverage < 0.95);
});

test('recent outcomes can reverse an old coefficient without numerical instability from correlated inputs', () => {
  const model = createAdaptiveRegressor({ halfLifeDays: 20, ridge: 2 });
  const x = Array(FEATURE_NAMES.length).fill(1);
  for (let i = 0; i < 150; i++) model.update(x, 1, date(i));
  assert.ok(model.predict(x).value > 0.8);
  for (let i = 150; i < 300; i++) model.update(x, -1, date(i));
  assert.ok(model.predict(x).value < -0.8);
  assert.ok(model.predict(x).coefficients.every(Number.isFinite));
  assert.throws(() => model.update(x, 1, date(0)), /chronological/);
});

test('calendar days and stock trading sessions are labelled separately; missing volume is explicit', () => {
  const bars = series(600).filter(b => ![0, 6].includes(new Date(b.date).getUTCDay()));
  const out = walkForwardAsset(bars, { symbol: 'STOCK', assetClass: 'stock', horizon: 5, asOf: date(600) });
  assert.equal(out.forecast.horizonUnit, 'trading-sessions');
  for (const row of out.outcomes) assert.ok(Date.parse(row.targetDate) - Date.parse(row.asOf) >= 7 * 86400000);
  const missing = series(100).map(b => ({ ...b, volume: null }));
  assert.equal(featuresAt(missing, 99).volumeAvailable, false);
});

test('all reported economic returns charge the configured round-trip cost and preserve losses', () => {
  const result = walkForwardAsset(series(400), { symbol: 'T', asOf: date(400), costBps: 5 });
  for (const row of result.outcomes) assert.ok(Math.abs(row.netReturnPct - (row.side ? row.side * row.actualPct - 0.05 : 0)) < 1e-12);
  assert.throws(() => walkForwardAsset(series(), { costBps: -1 }), /Invalid/);
});

test('report persistence is retry-safe and only advertises a fully stored run', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0041_adaptive_research.sql', import.meta.url), 'utf8'));
  const query = async (_env, sql, params = []) => db.prepare(sql).all(...params);
  const batch = async (_env, statements) => { for (const st of statements) db.prepare(st.sql).run(...st.params); };
  const report = buildAdaptiveReport([{ symbol: 'T', assetClass: 'crypto', bars: series(300) }], { asOf: date(300) });
  await persistAdaptiveReport({}, report, { query, batch });
  await persistAdaptiveReport({}, report, { query, batch });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_research_runs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_research_snapshots').get().n, 2);
  const health = await loadAdaptiveHealth({}, Date.parse(report.summary.generatedAt) + 48 * 3600000, query);
  assert.equal(health.status, 'stale');
  assert.equal(health.actionable, false);
  const failed = { ...report, runId: 'failed' };
  await assert.rejects(persistAdaptiveReport({}, failed, { query, batch: async () => { throw new Error('interrupted'); } }), /interrupted/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adaptive_research_runs').get().n, 1);
  db.close();
});

test('archive loader keeps same ticker classes separate and applies quarantine', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE asset_daily_bars(asset_class TEXT, symbol TEXT, date TEXT, close REAL, volume REAL, source TEXT);
    CREATE TABLE asset_bar_quarantine(asset_class TEXT, symbol TEXT, date TEXT, reason TEXT);
    INSERT INTO asset_daily_bars VALUES ('stock','SAME','2023-01-01',100,10,'test'), ('crypto','SAME','2023-01-01',1,10,'test');`);
  const query = async (_env, sql, params = []) => db.prepare(sql).all(...params);
  const panel = await loadAdaptivePanel(query, {}, '2023-01-02');
  assert.equal(panel.find(a => a.assetClass === 'stock').bars[0].close, 100);
  assert.equal(panel.find(a => a.assetClass === 'crypto').bars[0].close, 1);
  db.exec("INSERT INTO asset_bar_quarantine VALUES ('stock','SAME','2023-01-01','spike')");
  const quarantined = await loadAdaptivePanel(query, {}, '2023-01-02');
  assert.equal(quarantined.find(a => a.assetClass === 'stock').bars.length, 0);
  assert.equal(quarantined.find(a => a.assetClass === 'crypto').bars.length, 1);
  db.close();
});

test('composite reliability excludes the old weighting model while retaining unchanged technique evidence', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE forecast_outcomes (
    asset_class TEXT, symbol TEXT, series_key TEXT, horizon_minutes INTEGER,
    correct INTEGER, dir INTEGER, series_kind TEXT, aggregated INTEGER,
    model_version TEXT, label_version TEXT, run_at TEXT);
    INSERT INTO forecast_outcomes VALUES
    ('crypto','T','composite',1440,1,1,'technique',1,'confluence-v7','direction-deadband-0.5pct-v1','2023-01-01'),
    ('crypto','T','composite',1440,0,1,'technique',1,'confluence-v8','direction-deadband-0.5pct-v1','2023-01-02'),
    ('crypto','T','rsi',1440,1,1,'technique',1,'confluence-v7','direction-deadband-0.5pct-v1','2023-01-01'),
    ('crypto','T','rsi',1440,0,1,'technique',1,'confluence-v8','direction-deadband-0.5pct-v1','2023-01-02');`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    return Response.json({ success: true, result: [{ results: db.prepare(sql).all(...params) }] });
  };
  try {
    const stats = await loadReliability({});
    assert.equal(stats.blended['T|composite'].total, 1);
    assert.equal(stats.blended['T|composite'].accuracy, 0);
    assert.equal(stats.blended['T|rsi'].total, 2);
    assert.equal(stats.byHorizon[24]['crypto|T|composite|1'].total, 1);
  } finally { globalThis.fetch = realFetch; db.close(); }
});
