// Serves the build's aggregates of forecast_outcomes from KV.
//
// The build ran about 15 full aggregates of this ledger, back to back, on every
// refresh: 73% of all rows D1 read (636M of 869M a day) and 72% of its busy time,
// measured 2026-11-05. The longest averaged 21 s. D1 runs one query at a time, so
// everything else waited, and on 2026-11-04 it began refusing other jobs outright
// (7429 "DB is overloaded"), failing seven runs in a day.
//
// Those scans were nearly pointless: the ledger gains ~10k rows a day on ~2M, and
// one independent outcome per series per day, so an aggregate hardly moves from
// one hour to the next. So each result is reused for FRESH_HOURS, and a build
// redoes at most RESCANS_PER_RUN of the ones past that, which spreads them across
// builds instead of stacking them. The key hashes the SQL and its parameters, so
// a new model or label version starts clean by itself.
//
// A scan that fails serves the previous result. Without that the build withholds
// every call whose evidence is unavailable, for one busy moment on the database.
// Past HARD_HOURS nothing stale is served and the failure surfaces; the health
// check alarms before that (ledgerCacheFailHours), so a ledger that has outgrown
// D1's 30 s limit is a visible failure and not learning that has quietly stopped.
import { createHash } from 'node:crypto';
import { d1 } from './d1-client.mjs';

export const FRESH_HOURS = 6;
export const HARD_HOURS = 48;
export const RESCANS_PER_RUN = 2;
const EXPIRE_SECONDS = 7 * 86400; // keys of abandoned queries clean themselves up
const KV_TIMEOUT_MS = 30000;
const CHUNK_PAUSE_MS = 500;

// Lower bounds of eight ranges holding about an eighth of the ledger each
// (measured from technique_reliability, 2026-11-05). The first starts below every
// digit and the last has no upper bound, so symbols like 1INCH or 币安人生 are kept.
export const SYMBOL_CHUNKS = Object.freeze(['', 'B', 'D', 'G', 'L', 'O', 'S', 'U']);
// Marks where a chunked query takes its filter: the end of its WHERE clause, so
// the filter's parameters can simply follow the query's own.
export const CHUNK_SLOT = '/*ledger-chunk*/';

let run = { memo: new Map(), rescans: 0, failed: [], oldestHours: 0, served: 0 };
export function resetLedgerCacheRun() { run = { memo: new Map(), rescans: 0, failed: [], oldestHours: 0, served: 0 }; }
export function ledgerCacheStatus() {
  return { oldestHours: Math.round(run.oldestHours * 10) / 10, rescans: run.rescans, served: run.served, failed: [...run.failed] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// asset_class = ? AND symbol in range walks idx_forecast_outcomes_model_slice, so
// each chunk reads only its own rows (test-query-plans.mjs). One long statement
// becomes many short ones that other jobs can run between, and no single statement
// nears D1's 30 s limit as the ledger grows. Only for queries that GROUP BY
// asset_class, symbol: their groups never span two chunks, so the rows just add up.
export async function chunkedScan(env, sql, params, { pauseMs = CHUNK_PAUSE_MS } = {}) {
  const classes = (await d1(env, 'SELECT DISTINCT asset_class FROM technique_reliability')).map((r) => r.asset_class);
  if (!classes.length) return d1(env, sql.replace(CHUNK_SLOT, ''), params);
  const rows = [];
  for (const assetClass of classes) {
    for (let i = 0; i < SYMBOL_CHUNKS.length; i++) {
      const upper = SYMBOL_CHUNKS[i + 1];
      const filter = `AND asset_class = ? AND symbol >= ?${upper ? ' AND symbol < ?' : ''}`;
      const bound = [assetClass, SYMBOL_CHUNKS[i], ...(upper ? [upper] : [])];
      rows.push(...await d1(env, sql.replace(CHUNK_SLOT, filter), [...params, ...bound]));
      if (pauseMs) await sleep(pauseMs);
    }
  }
  return rows;
}

function kvUrl(env, key, query = '') {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${env.FCS_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}${query}`;
}

async function kvRead(env, key) {
  try {
    const res = await fetch(kvUrl(env, key), { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(KV_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const value = await res.json();
    return Array.isArray(value?.rows) && Number.isFinite(Date.parse(value.computedAt)) ? value : null;
  } catch (e) {
    console.warn(`[ledger-cache] read failed for ${key}, scanning instead: ${e.message || e}`);
    return null;
  }
}

async function kvWrite(env, key, value) {
  try {
    const res = await fetch(kvUrl(env, key, `?expiration_ttl=${EXPIRE_SECONDS}`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(KV_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[ledger-cache] write failed for ${key}, the next build scans again: ${e.message || e}`);
  }
}

// The rows of `sql`, from KV when recent enough. Without a KV namespace in `env`
// it is a plain query, which is what every caller outside the hourly build gets.
export async function ledgerRows(env, name, sql, params = [], { chunked = false, pauseMs, now = Date.now } = {}) {
  const whole = () => d1(env, sql.replace(CHUNK_SLOT, ''), params);
  if (!env.FCS_KV_NAMESPACE_ID) return whole();
  const scan = () => (chunked ? chunkedScan(env, sql, params, { pauseMs }) : whole());

  const hash = createHash('sha256').update(JSON.stringify([sql, params])).digest('hex').slice(0, 16);
  const key = `ledger-cache:${name}:${hash}`;
  if (run.memo.has(key)) return run.memo.get(key);

  const cached = await kvRead(env, key);
  const age = cached ? (now() - Date.parse(cached.computedAt)) / 3600000 : Infinity;
  const serve = () => {
    run.oldestHours = Math.max(run.oldestHours, age);
    run.served++;
    run.memo.set(key, cached.rows);
    return cached.rows;
  };
  if (age < FRESH_HOURS || (age < HARD_HOURS && run.rescans >= RESCANS_PER_RUN)) return serve();

  run.rescans++;
  let rows;
  try {
    rows = await scan();
  } catch (e) {
    run.failed.push(name);
    if (age >= HARD_HOURS) throw e;
    console.warn(`[ledger-cache] ${name} scan failed, serving the result from ${age.toFixed(1)}h ago: ${e.message || e}`);
    return serve();
  }
  await kvWrite(env, key, { computedAt: new Date(now()).toISOString(), rows });
  run.memo.set(key, rows);
  return rows;
}
