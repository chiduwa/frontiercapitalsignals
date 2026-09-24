// The tournament's forward ledger, against real SQLite built from the
// migration: a forecast once written is never rewritten, a score only fills
// an empty row, a re-run import adds nothing, and the payload loader marks a
// slot actionable only when its incumbent was promoted and the run is fresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { importResults, exportState, loadTournamentHealth, sameAsset, binanceFourHourOpens } from './scripts/model-tournament-io.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0048_model_tournament.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./migrations/0051_tournament_run_assets.sql', import.meta.url), 'utf8'));
  const query = async (_env, sql, params = []) => db.prepare(sql).all(...params);
  const batch = async (_env, statements) => { for (const s of statements) db.prepare(s.sql).run(...s.params); };
  return { db, query, batch };
}

const reg = (over = {}) => ({ model_id: 'direction:logistic:abc', symbol: 'BTC', target: 'direction', horizon: 1,
  spec_json: '{"family":"logistic"}', status: 'challenger', alpha_index: 1, admitted_at: '2026-09-22',
  epoch_start: '2026-09-23', incumbent_id: 'direction:baseRate:x', status_changed_at: '2026-09-23T15:00:00Z',
  e_value: null, e_worse: null, forward_n: 0, forward_mean_diff: null, backtest_json: '{"meanScaled":0.02}',
  reason: 'admitted', updated_at: '2026-09-23T15:00:00Z', ...over });
const fc = (over = {}) => ({ model_id: 'direction:logistic:abc', symbol: 'BTC', target: 'direction', horizon: 1,
  as_of: '2026-09-22', target_date: '2026-09-23', forecast_json: '{"pUp":0.61}', issued_at: '2026-09-23T15:00:00Z',
  code_version: 'model-tournament-v1', input_hash: 'h1', ...over });
const results = (over = {}) => ({ version: 'model-tournament-v1', runAt: '2026-09-23T15:00:00Z', asOf: '2026-09-22',
  inputHash: 'h1', forecasts: [fc()], scores: [], registry: [reg()],
  transitions: [{ model_id: 'direction:logistic:abc', symbol: 'BTC', horizon: 1, from_status: null, to_status: 'challenger',
    at: '2026-09-23T15:00:00Z', reason: 'admitted', e_value: null, forward_n: 0 }],
  summary: { assets: { BTC: { 'direction:1': { incumbent: 'direction:baseRate:x', promoted: false } } } }, ...over });

test('a forecast is written once; a later run cannot rewrite it', async () => {
  const { db, query, batch } = database();
  await importResults({}, results(), { batch, query });
  await importResults({}, results({ runAt: '2026-09-23T18:00:00Z', forecasts: [fc({ forecast_json: '{"pUp":0.99}', issued_at: '2026-09-23T18:00:00Z' })] }), { batch, query });
  const rows = db.prepare('SELECT forecast_json, issued_at FROM model_forecasts').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].forecast_json, '{"pUp":0.61}');
  assert.equal(rows[0].issued_at, '2026-09-23T15:00:00Z');
});

test('a score fills an empty loss and never overwrites a scored one', async () => {
  const { db, query, batch } = database();
  await importResults({}, results(), { batch, query });
  const score = l => ({ model_id: 'direction:logistic:abc', symbol: 'BTC', horizon: 1, as_of: '2026-09-22',
    outcome_json: '{"value":1.2}', loss: l, scored_at: '2026-09-24T15:00:00Z' });
  await importResults({}, results({ runAt: 'r2', forecasts: [], scores: [score(0.15)] }), { batch, query });
  await importResults({}, results({ runAt: 'r3', forecasts: [], scores: [score(0.99)] }), { batch, query });
  assert.equal(db.prepare('SELECT loss FROM model_forecasts').get().loss, 0.15);
});

test('the registry keeps what a model is, updates where it stands, and history never duplicates', async () => {
  const { db, query, batch } = database();
  await importResults({}, results(), { batch, query });
  await importResults({}, results(), { batch, query });
  await importResults({}, results({ runAt: 'r2', forecasts: [],
    registry: [reg({ status: 'champion', spec_json: '{"family":"TAMPERED"}', e_value: 41.2, forward_n: 88, backtest_json: null })] }), { batch, query });
  const r = db.prepare('SELECT * FROM model_registry').get();
  assert.equal(r.status, 'champion');
  assert.equal(r.e_value, 41.2);
  assert.equal(r.spec_json, '{"family":"logistic"}', 'the spec a model was admitted with is immutable');
  assert.equal(r.backtest_json, '{"meanScaled":0.02}', 'a null backtest never erases the one recorded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_registry_history').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_tournament_runs').get().n, 2);
});

test('export returns the whole registry and the ledger of models still in play only', async () => {
  const { query, batch } = database();
  await importResults({}, results({
    registry: [reg(), reg({ model_id: 'direction:logistic:old', status: 'retired' })],
    forecasts: [fc(), fc({ model_id: 'direction:logistic:old' }), fc({ as_of: '2020-01-01', target_date: '2020-01-02' })]
  }), { batch, query });
  const state = await exportState({}, { query, nowMs: Date.parse('2026-09-23T16:00:00Z') });
  assert.equal(state.registry.length, 2, 'retired rows stay: they record what was already tried');
  assert.deepEqual(state.ledger.map(r => `${r.model_id}@${r.as_of}`), ['direction:logistic:abc@2026-09-22']);
});

test('the payload marks a slot actionable only when promoted and fresh', async () => {
  const { query, batch } = database();
  const summary = { assets: { BTC: { 'direction:1': { promoted: false }, 'magnitude:1': { promoted: true } } } };
  await importResults({}, results({ summary }), { batch, query });
  const now = Date.parse('2026-09-23T20:00:00Z');
  const live = await loadTournamentHealth({}, now, query);
  assert.equal(live.status, 'live');
  assert.equal(live.assets.BTC['direction:1'].actionable, false);
  assert.equal(live.assets.BTC['magnitude:1'].actionable, true);
  const stale = await loadTournamentHealth({}, now + 48 * 3600000, query);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.actionable, false);
  assert.equal(stale.assets.BTC['magnitude:1'].actionable, false);
  const empty = database();
  assert.equal((await loadTournamentHealth({}, now, empty.query)).status, 'awaiting-first-run');
});

test('a wide universe publishes the always-tracked, the pools and whatever was promoted; the rest stays in D1', async () => {
  const { db, query, batch } = database();
  const slot = promoted => ({ 'direction:1': { incumbent: 'x', promoted }, 'magnitude:1': { incumbent: 'y', promoted: false } });
  const summary = { assets: { BTC: slot(false), '*': slot(false), '*stock': slot(false), LINK: slot(true), NVDA: slot(false), AAPL: slot(true) },
    weights: { BTC: { groupShare: { momentum: 1 } }, LINK: { groupShare: { volume: 1 } } },
    classes: { BTC: 'crypto', '*': 'crypto', '*stock': 'stock', LINK: 'crypto', NVDA: 'stock', AAPL: 'stock' }, universe: { crypto: 40, stock: 40 } };
  await importResults({}, results({ summary }), { batch, query });
  const run = JSON.parse(db.prepare('SELECT summary_json FROM model_tournament_runs').get().summary_json);
  assert.equal(run.assets, undefined, 'the run row no longer carries every asset');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_tournament_run_assets').get().n, 6);
  const h = await loadTournamentHealth({}, Date.parse('2026-09-23T20:00:00Z'), query);
  assert.deepEqual(Object.keys(h.assets).sort(), ['*', '*stock', 'AAPL', 'BTC', 'LINK']);
  assert.deepEqual(h.promotedElsewhere.sort(), ['AAPL', 'LINK']);
  assert.equal(h.assets.LINK['direction:1'].actionable, true);
  assert.equal(h.classes.AAPL, 'stock');
  assert.deepEqual(h.weights.LINK, { groupShare: { volume: 1 } });
  assert.equal(h.universe.stock, 40);
});

test('a run written before the split still loads', async () => {
  const { db, query } = database();
  db.prepare(`INSERT INTO model_tournament_runs (run_id, model_version, created_at, as_of, input_hash, summary_json)
    VALUES ('model-tournament-v1:old', 'model-tournament-v1', '2026-09-23T19:23:50Z', '2026-09-22', 'h', ?)`)
    .run(JSON.stringify({ assets: { BTC: { 'direction:1': { promoted: false } } } }));
  const h = await loadTournamentHealth({}, Date.parse('2026-09-23T20:00:00Z'), query);
  assert.deepEqual(Object.keys(h.assets), ['BTC']);
});

test('4-hour opens page forward, and a different asset under the same ticker is refused', async () => {
  const t0 = Date.UTC(2025, 0, 1);
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const start = Number(new URL(url).searchParams.get('startTime'));
    const first = Math.max(0, Math.ceil((start - t0) / (4 * 3600000)));
    return Array.from({ length: Math.max(0, Math.min(1000, 2500 - first)) }, (_, k) => [t0 + (first + k) * 4 * 3600000, '0.25']);
  };
  const opens = await binanceFourHourOpens('ARB', { fetcher, nowMs: t0 + 2500 * 4 * 3600000, days: 500 });
  assert.equal(calls.length, 3);
  assert.equal(new Set(opens.map(o => o[0])).size, opens.length, 'no candle twice across pages');
  assert.ok(sameAsset(opens, 0.26));
  assert.ok(!sameAsset(opens, 25), 'ARB-USD on Yahoo is a $0.0006 token; the reverse mismatch is refused too');
});
