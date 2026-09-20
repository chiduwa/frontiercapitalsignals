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

// How many symbols' bars to ask for at once. Two independent ceilings: D1 caps
// a statement at 100 bound parameters, and it also caps how much one query may
// RETURN. 20 keeps each response a few MB with ~1 round trip per 20 symbols.
export const BAR_SYMBOL_CHUNK = 20;

// Reads the WHOLE asset_daily_bars archive in symbol batches.
//
// It used to be one `SELECT ... FROM asset_daily_bars ORDER BY symbol, date`
// per caller. On 2026-09-11 the archive outgrew what a single D1 request may
// return and those reads began failing with
// `HTTP 503 [{"code":7010,"message":"Service unavailable"}]`. 7010 on a plain
// SELECT is a SIZE ceiling, not an outage: it fails identically on every retry,
// so waiting never clears it. Signals Discovery died outright for five straight
// days; daily-refresh's shared read is inside a try/catch, so it degraded
// SILENTLY instead — the job stayed green while lead/lag and support/resistance
// quietly lost their input. That second failure mode is the reason this lives
// here rather than being fixed once at the call site that happened to shout.
//
// Ordering is byte-for-byte what the single query produced: the symbol list is
// ordered, each batch is ordered by (symbol, date), and a symbol is never split
// across batches — so callers that relied on a global symbol-major sort are
// unaffected. `columns` and the WHERE fragments are code-controlled literals,
// never caller input; every VALUE is still bound.
export async function readAllDailyBars(env, columns, options = {}) {
  const { symbolWhere = '', extraWhere = '', extraParams = [], chunkSize = BAR_SYMBOL_CHUNK } = options;
  const symbolRows = await d1(env,
    `SELECT DISTINCT symbol FROM asset_daily_bars${symbolWhere ? ` WHERE ${symbolWhere}` : ''} ORDER BY symbol`);
  const symbols = symbolRows.map((r) => r.symbol);
  const out = [];
  for (const group of chunk(symbols, chunkSize)) {
    const placeholders = group.map(() => '?').join(', ');
    const rows = await d1(env,
      `SELECT ${columns} FROM asset_daily_bars WHERE symbol IN (${placeholders})`
      + `${extraWhere ? ` AND ${extraWhere}` : ''} ORDER BY symbol, date`,
      [...group, ...extraParams]);
    for (const row of rows) out.push(row);
  }
  return out;
}

// How many rows to take per page in readAllRows. Sized like BAR_SYMBOL_CHUNK
// above: small enough that a page stays a few MB whatever the row width, large
// enough that an ordinary table is one or two round trips.
export const ROW_PAGE_SIZE = 5000;

// Reads an arbitrary ordered query in pages, for the OTHER shape of the same
// 7010 problem readAllDailyBars exists for.
//
// readAllDailyBars fixed the table that had already outgrown a single D1
// response. It is not the only one that will: any `SELECT ... FROM t WHERE
// <constant>` over an append-only table is a size ceiling with a date on it,
// and the failure is nasty precisely because nothing changes on the day it
// arrives — the query is the same, the data is the same shape, and the error
// is a 503 that reads like an outage and never clears on retry.
//
// The caller supplies the ordering, which must be a TOTAL order (enough
// columns to break every tie), or paging would drop and duplicate rows across
// page boundaries. Safe under LIMIT/OFFSET because these jobs hold a
// concurrency group and write before they read, so no one is inserting
// underneath the pagination.
// The paging loop itself, with the transport handed in. Separated so the
// boundary behaviour that makes paging dangerous — the short page that ends
// it, and the exactly-full last page that does not — is testable without a
// database. `fetchPage(limit, offset)` returns one page of rows.
export async function pageAll(fetchPage, pageSize = ROW_PAGE_SIZE) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(pageSize, offset);
    for (const row of page) out.push(row);
    // A short page is the only proof there is nothing after it. A full page
    // is never trusted, even when it is the last one — that costs one extra
    // empty read per exact multiple, which is the cheap side of this trade.
    if (page.length < pageSize) return out;
  }
}

export async function readAllRows(env, sql, params = [], options = {}) {
  const { pageSize = ROW_PAGE_SIZE } = options;
  // LIMIT/OFFSET are code-controlled numbers, never caller input; every VALUE
  // is still bound through params, exactly as readAllDailyBars does.
  return pageAll((limit, offset) => d1(env, `${sql} LIMIT ${limit} OFFSET ${offset}`, params), pageSize);
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
