// Thin HTTP client for Cloudflare D1's REST API. Extracted from
// reliability.mjs (which was the only caller until the archive/backfill
// scripts needed the exact same thing) so there's one source of truth for
// how every script talks to D1, not a hand-copied duplicate that could
// drift. Requires plain Node (fetch), same as every other script here.

function d1Url(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.FCS_D1_DATABASE_ID}/query`;
}

// Every D1 call from every script (reliability.mjs, archive.mjs,
// correlation-research.mjs, build-signals.mjs, daily-refresh.mjs — this is
// the one shared client, per this file's own docs above) went through
// plain fetch() with no timeout at all until now. Found live, 2026-08-22:
// a signals-refresh run built its payload and wrote it to KV in a normal
// ~10 minutes, then produced zero further log output for 18 straight
// minutes (not even logRun's own try/catch error message) until the
// workflow's 28-minute timeout finally killed it — a real D1 HTTP hang,
// not a slow query (D1 queries in this project complete in single-digit
// milliseconds even against the 688K-row asset_daily_bars table,
// confirmed live via direct query metadata; there is no legitimate reason
// for one to take more than a few seconds). 30s is generous headroom for
// even a large result-set transfer while still bounding what used to be
// an unbounded hang — same AbortController pattern already proven safe in
// archive.mjs's fetchJson (fixed earlier the same day for the identical
// class of bug) and worker.js's own fetchWithTimeout.
const D1_TIMEOUT_MS = 30000;

export async function d1(env, sql, params = []) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), D1_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(d1Url(env), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(t);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success !== true) {
    throw new Error(`D1 query failed: HTTP ${res.status} ${JSON.stringify(body && body.errors)}`);
  }
  return (body.result && body.result[0] && body.result[0].results) || [];
}

// Runs several statements as one D1 batch transaction. This is intentionally
// separate from forEachConcurrent below: concurrency is useful for independent
// bulk writes, while a learning outcome and the aggregates derived from it must
// either all commit or all roll back. The REST API's `batch` form has the same
// transactional semantics as D1Database.batch: statements execute in order and
// a failure rolls the batch back. See Cloudflare's Query D1 Database API.
export async function d1Batch(env, statements) {
  if (!Array.isArray(statements) || !statements.length) return [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), D1_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(d1Url(env), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch: statements.map((statement) => ({
          sql: statement.sql,
          params: statement.params || []
        }))
      }),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(t);
  }
  const body = await res.json().catch(() => null);
  const results = body && Array.isArray(body.result) ? body.result : [];
  const failed = results.find((result) => result && result.success === false);
  if (!res.ok || !body || body.success !== true || failed) {
    throw new Error(`D1 batch failed: HTTP ${res.status} ${JSON.stringify((body && body.errors) || failed)}`);
  }
  return results.map((result) => (result && result.results) || []);
}

// D1's REST API accepts independent statements concurrently, but opening one
// request for every write batch can rate-limit the shared API and recreate the
// same backlog. This bounded queue is used for bulk, order-independent writes.
export async function forEachConcurrent(items, limit, fn) {
  const workerCount = Math.min(Math.max(1, limit), items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
