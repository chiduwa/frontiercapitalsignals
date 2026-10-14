// Exercise the production fetch-to-record path without network access or credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runShadow, createBaselineStore, monthFile, strictNumber, metricSample, validateCandles } from './scripts/fuel-shadow.mjs';

const FIVE = 300_000, HOUR = 3_600_000;
const T0 = Date.parse('2026-10-13T12:00:00Z'), ASOF = T0 + HOUR, NOW = ASOF + 4 * 60_000;
const alert = { symbol: 'RED', cast_at: new Date(T0 - HOUR).toISOString(), configs: 'exhaustion20', entry_price: 100 };
const candles = (start, count, premium = false) => Array.from({ length: count }, (_, i) => {
  const t = start + i * FIVE;
  return premium ? [t, '-0.004', '-0.003', '-0.005', '-0.004', '0', t + FIVE - 1, '0']
    : [t, '100', '102', '99', '102', '1', t + FIVE - 1, String((i + 1) * 100)];
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fcs-fuel-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = {
    '/fapi/v1/exchangeInfo': { symbols: [{ symbol: 'REDUSDT', contractType: 'PERPETUAL', status: 'TRADING' }] },
    '/fapi/v1/klines': candles(T0, 12),
    '/fapi/v1/premiumIndexKlines': candles(ASOF - 6 * FIVE, 6, true),
    '/futures/data/openInterestHist': [{ timestamp: T0, sumOpenInterest: '100' }, { timestamp: ASOF, sumOpenInterest: '106' }],
    '/futures/data/globalLongShortAccountRatio': [{ timestamp: T0, longShortRatio: '1.5' }, { timestamp: ASOF, longShortRatio: '1.3' }]
  };
  const emitted = [], requests = [], failed = new Set();
  let now = NOW, queryResult = [alert], queryError = false;
  const options = { dir, env: {}, clock: () => now, log: () => {}, runId: 'test-run',
    emit: (kind, row) => emitted.push({ kind, row }),
    query: async (_env, sql) => { assert.match(sql, /^SELECT /); if (queryError) throw new Error('cohort offline'); return structuredClone(queryResult); },
    fetchFn: async (url, init) => {
      assert.ok(init.signal); const u = new URL(url); requests.push(u);
      assert.ok(Object.hasOwn(data, u.pathname), 'only expected public read endpoints');
      return { ok: !failed.has(u.pathname), status: failed.has(u.pathname) ? 503 : 200,
        json: async () => structuredClone(data[u.pathname]) };
    }
  };
  return { dir, data, options, emitted, requests, failed,
    setNow: (value) => { now = value; }, setAlerts: (value) => { queryResult = value; },
    failQuery: () => { queryError = true; },
    run: (extra = {}) => runShadow({ ...options, ...extra }),
    state: () => emitted.filter((r) => r.kind === 'event').at(-1)?.row };
}

test('complete observations preserve raw inputs, source times, immutable baselines and availability', async (t) => {
  const f = fixture(t), summary = await f.run(), r = f.state();
  assert.equal(summary.expected_events, 1); assert.equal(summary.written_events, 1);
  assert.equal(r.status, 'complete'); assert.equal(r.signs3, 3); assert.equal(r.signs4, 4);
  assert.equal(r.schema_version, 2); assert.equal(r.protocol.id, 'fuel-shadow-prospective-v2');
  assert.match(r.source_version.sha256, /^[a-f0-9]{64}$/);
  assert.equal(r.price_asof, new Date(ASOF).toISOString());
  assert.equal(r.decision_available_at, new Date(NOW).toISOString());
  assert.equal(r.inputs.metrics.oi.baseline.sample.value, 100);
  assert.equal(r.inputs.metrics.oi.current.value, 106);
  assert.equal(r.inputs.metrics.oi.current.timestamp, ASOF);
  assert.deepEqual(r.inputs.candles.raw_rows, f.data['/fapi/v1/klines']);
  assert.equal(r.sources.oi.received_at, r.received);
  assert.equal(f.requests.find((u) => u.pathname === '/fapi/v1/klines').searchParams.get('endTime'), String(ASOF - 1));
  assert.deepEqual(f.emitted.filter((r) => r.kind === 'run').map((r) => r.row.record_type), ['run_started', 'run_plan', 'run_complete']);

  const id = r.event_id, check = r.check_id;
  f.data['/futures/data/openInterestHist'][0].sumOpenInterest = '90';
  await f.run({ runId: 'test-run-2' });
  const revised = f.state();
  assert.equal(revised.inputs.metrics.oi.baseline.sample.value, 100, 'historical revision must not move the baseline');
  assert.equal(revised.inputs.metrics.oi.reference_candidate.value, 90);
  assert.equal(revised.inputs.metrics.oi.baseline_revision_observed, true);
  assert.equal(revised.inputs.metrics.oi.baseline_origin, 'frozen');
  assert.equal(revised.event_id, id); assert.equal(revised.check_id, check);
  assert.notEqual(revised.observation_id, r.observation_id);
});

test('missing or malformed premium is unavailable, while an explicit zero is valid', async (t) => {
  const f = fixture(t);
  for (const bad of [null, '', ' ', false, 'not-a-number']) {
    f.data['/fapi/v1/premiumIndexKlines'][2][4] = bad;
    await f.run(); const r = f.state();
    assert.equal(r.disc, null); assert.equal(r.signs3, null);
    assert.equal(r.build, true); assert.equal(r.accel, true); assert.equal(r.status, 'partial');
  }
  f.data['/fapi/v1/premiumIndexKlines'] = candles(ASOF - 6 * FIVE, 6, true).map((r) => {
    r[1] = r[2] = r[3] = r[4] = '0'; return r;
  });
  await f.run(); assert.equal(f.state().prem30, 0); assert.equal(f.state().disc, false);
  for (const bad of [null, '', ' ', false, Infinity, 'NaN']) assert.equal(strictNumber(bad), null);
});

test('stale premium and gappy or duplicate price grids cannot become valid signals', async (t) => {
  const f = fixture(t);
  f.data['/fapi/v1/premiumIndexKlines'] = candles(ASOF - 7 * FIVE, 6, true);
  f.data['/fapi/v1/klines'].splice(4, 1);
  await f.run(); let r = f.state();
  assert.equal(r.disc, null); assert.equal(r.near_high, null); assert.equal(r.accel, null);
  assert.equal(r.price, 102, 'a valid independent latest quote is retained'); assert.equal(r.build, true);
  assert.ok(r.inputs.candles.reasons.includes('missing_expected_bar'));
  f.data['/fapi/v1/klines'] = candles(T0, 12);
  f.data['/fapi/v1/klines'][4] = f.data['/fapi/v1/klines'][3];
  await f.run(); r = f.state();
  assert.equal(r.near_high, null); assert.ok(r.inputs.candles.reasons.includes('duplicate_open_time'));
});

test('invalid quote volume invalidates thrust but not independently valid price or OI', async (t) => {
  const f = fixture(t); f.data['/fapi/v1/klines'][11][7] = null;
  await f.run(); const r = f.state();
  assert.equal(r.accel, null); assert.equal(r.decaying, null); assert.equal(r.signs4, null);
  assert.equal(r.near_high, true); assert.equal(r.build, true); assert.equal(r.signs3, 3);
  assert.equal(r.inputs.thrust.volume_valid, false);
});

test('source failure preserves other features and records explicit coverage', async (t) => {
  const f = fixture(t); f.failed.add('/futures/data/openInterestHist');
  const summary = await f.run(), r = f.state();
  assert.equal(r.build, null); assert.equal(r.crowd, true); assert.equal(r.disc, true);
  assert.equal(r.signs3, null); assert.equal(r.sources.oi.status, 'error');
  assert.ok(r.reasons.includes('oi_source_error')); assert.equal(summary.counts.partial, 1);
});

test('unsupported assets and exchange-info outages are represented rather than silently dropped', async (t) => {
  const f = fixture(t); f.setAlerts([alert, { ...alert, symbol: 'NO_PERP' }]);
  let summary = await f.run();
  assert.equal(summary.written_events, 2); assert.equal(summary.counts.unavailable, 1);
  assert.ok(f.state().reasons.includes('unsupported_perp'));
  f.failed.add('/fapi/v1/exchangeInfo'); summary = await f.run();
  assert.equal(summary.written_events, 2); assert.equal(summary.counts.unavailable, 2);
  assert.ok(f.state().reasons.includes('exchange_info_unavailable'));
});

test('cohort errors and empty runs have durable summaries with distinct meanings', async (t) => {
  const f = fixture(t); f.failQuery();
  let summary = await f.run(); assert.equal(summary.status, 'failed'); assert.equal(summary.expected_events, null);
  assert.equal(f.requests.length, 0); assert.equal(f.state(), undefined);
  const empty = fixture(t); empty.setAlerts([]); summary = await empty.run();
  assert.equal(summary.status, 'complete'); assert.equal(summary.expected_events, 0); assert.equal(empty.requests.length, 0);
});

test('receipt freshness rejects delayed data even when the requested bars look complete', async (t) => {
  const f = fixture(t), fetchOriginal = f.options.fetchFn;
  f.options.fetchFn = async (url, init) => {
    const result = await fetchOriginal(url, init);
    if (new URL(url).pathname !== '/fapi/v1/exchangeInfo') f.setNow(ASOF + 11 * 60_000);
    return result;
  };
  await f.run(); const r = f.state();
  assert.equal(r.price, null); assert.equal(r.near_high, null); assert.equal(r.disc, null);
  assert.equal(r.build, null); assert.equal(r.status, 'unavailable');
  assert.ok(r.reasons.includes('price_asof_stale_at_receipt'));
});

test('stale, duplicate and invalid metrics are rejected; future snapshots cannot leak in', () => {
  assert.equal(metricSample([{ timestamp: T0, sumOpenInterest: '100' }], ASOF, 'sumOpenInterest').value, null);
  const current = { timestamp: ASOF, sumOpenInterest: '106' };
  assert.equal(metricSample([current, current], ASOF, 'sumOpenInterest').reason, 'duplicate_metric_timestamp');
  assert.equal(metricSample([{ ...current, sumOpenInterest: '' }], ASOF, 'sumOpenInterest').value, null);
  assert.equal(metricSample([current, { timestamp: ASOF + FIVE, sumOpenInterest: '999' }], ASOF, 'sumOpenInterest').value, 106);
  const malformed = candles(T0, 12); malformed[0][6] -= 1;
  assert.equal(validateCandles(malformed, T0, ASOF).price_valid, false);
});

test('the modeled-entry excursion excludes price highs before the modeled entry', async (t) => {
  const f = fixture(t); f.data['/fapi/v1/klines'][0][2] = '150';
  await f.run(); const r = f.state();
  assert.equal(r.high_since_alert, 150); assert.equal(r.high_since_entry, 102);
  assert.ok(Math.abs(r.runup - 0.02) < 1e-12);
});

test('run budget exhaustion records remaining cohort members as unavailable', async (t) => {
  const f = fixture(t); f.setAlerts([alert, { ...alert, symbol: 'NEXT' }]);
  await f.run({ maxRunMs: -1 });
  assert.equal(f.emitted.filter((r) => r.kind === 'event').length, 2);
  assert.ok(f.state().reasons.includes('run_budget_exceeded'));
  assert.equal(f.requests.length, 1, 'only exchangeInfo is requested before budget exhaustion');
});

test('file output appends without rewriting legacy rows; frozen baseline corruption is visible', async (t) => {
  const f = fixture(t), file = monthFile(f.dir, NOW), legacy = '{"legacy":true}\n';
  writeFileSync(file, legacy);
  await f.run({ emit: undefined });
  assert.ok(readFileSync(file, 'utf8').startsWith(legacy));
  const runFile = join(f.dir, 'fuel-shadow-runs-2026-10.ndjson');
  assert.equal(readFileSync(runFile, 'utf8').trim().split('\n').length, 3);
  const baseDir = join(f.dir, 'baselines', 'fuel-shadow-prospective-v2');
  for (const name of readdirSync(baseDir)) writeFileSync(join(baseDir, name), '{}');
  await f.run({ baselineStore: createBaselineStore(f.dir) });
  assert.equal(f.state().build, null); assert.equal(f.state().crowd, null);
  assert.ok(f.state().reasons.includes('oi_baseline_unavailable'));
});
