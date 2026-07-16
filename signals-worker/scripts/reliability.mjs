// D1-backed reliability learning loop for the confluence engine. Runs from
// build-signals.mjs (plain Node, GitHub Actions) — the Worker itself never
// touches D1, only the hourly build needs this, not request-time serving.
// Talks to Cloudflare's D1 HTTP API directly, same pattern as the KV write
// in build-signals.mjs.
import { MIN_RELIABILITY_SAMPLES } from '../worker.js';

const HORIZONS_HOURS = [24, 168];
const EVAL_COLUMN = { 24: 'evaluated_24', 168: 'evaluated_168' };
// A move smaller than this counts as "flat" (actual_dir 0), not a win for
// either directional call — mirrors the deadband idea already used
// elsewhere in the engine (e.g. Donchian's 3% proximity bands).
const OUTCOME_DEADBAND_PCT = 0.5;
// Rows per multi-row statement: keeps bound params well under SQLite's
// classic ~999-per-statement ceiling (100 rows x 5 cols = 500).
const CHUNK = 100;
// A bit past the longer 168h horizon, for the price-log join plus buffer.
const RETENTION_HOURS = 200;
// Hard cap regardless of evaluated status, so a symbol that drops out of
// the universe (delisted stock, coin falls out of top-100) can't leave
// orphaned rows growing forever.
const HARD_CAP_HOURS = 24 * 30;

function d1Url(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.FCS_D1_DATABASE_ID}/query`;
}

async function d1(env, sql, params = []) {
  const res = await fetch(d1Url(env), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success !== true) {
    throw new Error(`D1 query failed: HTTP ${res.status} ${JSON.stringify(body && body.errors)}`);
  }
  return (body.result && body.result[0] && body.result[0].results) || [];
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Blended across horizons: sums raw correct/total (equivalent to a
// total-weighted average of each horizon's accuracy) rather than averaging
// the two accuracy percentages directly, so a horizon with more matured
// samples gets proportionally more say.
export async function loadReliability(env) {
  const rows = await d1(env, 'SELECT symbol, technique_id, correct, total FROM technique_reliability WHERE total > 0');
  const acc = {};
  for (const r of rows) {
    const key = `${r.symbol}|${r.technique_id}`;
    if (!acc[key]) acc[key] = { correct: 0, total: 0 };
    acc[key].correct += r.correct;
    acc[key].total += r.total;
  }
  const out = {};
  for (const [key, v] of Object.entries(acc)) {
    out[key] = { accuracy: v.total ? v.correct / v.total : 0.5, total: v.total };
  }
  return out;
}

// Persists this run's per-asset price and per-technique directional votes,
// to be scored once they mature (see evaluateMatured).
export async function logRun(env, runAt, log) {
  for (const batch of chunk(log.prices, CHUNK)) {
    const placeholders = batch.map(() => '(?,?,?,?)').join(',');
    const params = batch.flatMap((p) => [runAt, p.asset_class, p.symbol, p.price]);
    await d1(env, `INSERT OR REPLACE INTO asset_price_log (run_at, asset_class, symbol, price) VALUES ${placeholders}`, params);
  }
  for (const batch of chunk(log.votes, CHUNK)) {
    const placeholders = batch.map(() => '(?,?,?,?,?)').join(',');
    const params = batch.flatMap((v) => [runAt, v.asset_class, v.symbol, v.technique_id, v.dir]);
    await d1(env, `INSERT OR REPLACE INTO technique_votes (run_at, asset_class, symbol, technique_id, dir) VALUES ${placeholders}`, params);
  }
}

// Finds technique_votes rows old enough to have matured for each horizon
// and not yet scored for it, compares that run's logged price against the
// most recent price on record for the same symbol, and folds the
// correct/incorrect outcome into technique_reliability. Returns how many
// (symbol, technique, horizon) outcomes were scored this call.
export async function evaluateMatured(env, nowIso) {
  const now = new Date(nowIso).getTime();
  let evaluatedCount = 0;

  for (const h of HORIZONS_HOURS) {
    const cutoff = new Date(now - h * 3600 * 1000).toISOString();
    const col = EVAL_COLUMN[h];
    const due = await d1(env, `SELECT run_at, asset_class, symbol, technique_id, dir FROM technique_votes WHERE run_at <= ? AND ${col} = 0`, [cutoff]);
    if (!due.length) continue;

    // Most recent logged price per symbol ("now"). Builds run hourly, so
    // the set of distinct symbols among "due" rows is at most the universe
    // size, not unbounded.
    const symbols = [...new Set(due.map((r) => r.symbol))];
    const priceNow = {};
    for (const batch of chunk(symbols, CHUNK)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await d1(env, `SELECT symbol, price FROM asset_price_log WHERE symbol IN (${placeholders}) ORDER BY run_at DESC`, batch);
      for (const r of rows) if (!(r.symbol in priceNow)) priceNow[r.symbol] = r.price; // first hit per symbol = most recent
    }

    // Price at forecast time. "due" rows cluster into a small number of
    // distinct run_at values each call (roughly one per elapsed hour since
    // this last ran), so this stays a handful of queries, not one per row.
    const runAts = [...new Set(due.map((r) => r.run_at))];
    const priceBefore = {};
    for (const runAt of runAts) {
      const rows = await d1(env, 'SELECT symbol, price FROM asset_price_log WHERE run_at = ?', [runAt]);
      for (const r of rows) priceBefore[`${runAt}|${r.symbol}`] = r.price;
    }

    const deltas = {}; // "symbol|technique_id" -> { correct, total, asset_class }
    const evaluatedSymbolsByRunAt = {}; // only mark rows we could actually score
    for (const r of due) {
      const before = priceBefore[`${r.run_at}|${r.symbol}`];
      const after = priceNow[r.symbol];
      if (before == null || after == null || !before) continue; // symbol vanished from the universe; leave pending, hard-cap prune handles it eventually
      const pct = ((after / before) - 1) * 100;
      const actualDir = pct > OUTCOME_DEADBAND_PCT ? 1 : pct < -OUTCOME_DEADBAND_PCT ? -1 : 0;
      const key = `${r.symbol}|${r.technique_id}`;
      if (!deltas[key]) deltas[key] = { correct: 0, total: 0, asset_class: r.asset_class };
      deltas[key].total += 1;
      if (r.dir === actualDir) deltas[key].correct += 1;
      (evaluatedSymbolsByRunAt[r.run_at] ??= new Set()).add(r.symbol);
    }

    for (const [key, d] of Object.entries(deltas)) {
      const [symbol, techniqueId] = key.split('|');
      await d1(env, `
        INSERT INTO technique_reliability (asset_class, symbol, technique_id, horizon_hours, correct, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, technique_id, horizon_hours) DO UPDATE SET
          correct = technique_reliability.correct + excluded.correct,
          total = technique_reliability.total + excluded.total,
          accuracy = CAST(technique_reliability.correct + excluded.correct AS REAL) / (technique_reliability.total + excluded.total),
          updated_at = excluded.updated_at
      `, [d.asset_class, symbol, techniqueId, h, d.correct, d.total, d.total ? d.correct / d.total : 0, nowIso]);
      evaluatedCount += d.total;
    }

    for (const [runAt, symSet] of Object.entries(evaluatedSymbolsByRunAt)) {
      for (const batch of chunk([...symSet], CHUNK)) {
        const placeholders = batch.map(() => '?').join(',');
        await d1(env, `UPDATE technique_votes SET ${col} = 1 WHERE run_at = ? AND symbol IN (${placeholders})`, [runAt, ...batch]);
      }
    }
  }

  const retentionCutoff = new Date(now - RETENTION_HOURS * 3600 * 1000).toISOString();
  await d1(env, 'DELETE FROM technique_votes WHERE run_at < ? AND evaluated_24 = 1 AND evaluated_168 = 1', [retentionCutoff]);
  await d1(env, 'DELETE FROM asset_price_log WHERE run_at < ?', [retentionCutoff]);
  const hardCapCutoff = new Date(now - HARD_CAP_HOURS * 3600 * 1000).toISOString();
  await d1(env, 'DELETE FROM technique_votes WHERE run_at < ?', [hardCapCutoff]);
  await d1(env, 'DELETE FROM asset_price_log WHERE run_at < ?', [hardCapCutoff]);

  return evaluatedCount;
}

export { MIN_RELIABILITY_SAMPLES };
