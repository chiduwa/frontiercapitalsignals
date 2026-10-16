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

// ---- transient failures ------------------------------------------------------
//
// Cloudflare's D1 REST API fails a small share of requests on its own side:
// `HTTP 500 [{"code":7500,"message":"internal error; reference = ..."}]`, a TLS
// socket closed mid-response ("fetch failed ... other side closed"), or no
// answer inside D1_TIMEOUT_MS. Until 2026-10-16 the first of those ended the
// whole job. Signals Microstructure makes several hundred sequential calls per
// run and failed this way 14 times between 09-30 and 10-14, each time on a call
// that worked on the next run; Adaptive Research died on a timed-out page of
// bars on 10-15.
//
// A retry is only safe when running the statement twice cannot change the
// result. A failure that arrives after the request left this machine (a 5xx, a
// dropped socket, our own timeout) does not say whether D1 committed it, and
// `oos_checks = oos_checks + 1` (microstructure.mjs) or a plain INSERT into a
// run log would then count twice. So:
//   - never sent (DNS, refused or timed-out connect) or 429: retry anything;
//   - outcome unknown: retry only statements that are safe to repeat;
//   - anything else, including every 4xx (bad SQL) and the 7010 size ceiling,
//     which fails identically every time (see readAllDailyBars): throw at
//     once, as before.
export const D1_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000]);

const UNSENT_CAUSES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT']);

function httpFailure(message, res, body) {
  const err = new Error(message);
  const codes = ((body && body.errors) || []).map((e) => e && e.code);
  err.d1Outcome = res.status === 429 ? 'unsent'
    : res.status >= 500 && !codes.includes(7010) ? 'unknown'
    : res.ok && !body ? 'unknown' // a 200 whose body never arrived whole
    : null;
  return err;
}

export function failureOutcome(err) {
  if (!err) return null;
  if (err.d1Outcome !== undefined) return err.d1Outcome;
  if (err.name === 'AbortError') return 'unknown';
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return UNSENT_CAUSES.has(err.cause && err.cause.code) ? 'unsent' : 'unknown';
  }
  return null;
}

// Upper-cased SQL with string literals emptied and comments dropped, so a
// keyword inside a value ('pattern decayed', '-- x') cannot be mistaken for SQL.
function normaliseSql(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      out += "''";
      i = j;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      out += ' ';
      i = j === -1 ? sql.length : j;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      out += ' ';
      i = j === -1 ? sql.length : j + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/\s+/g, ' ').trim().toUpperCase();
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

// `col = ?`, a literal or `excluded.col` sets the same value however often it
// runs. Anything that reads the row (`n = n + 1`, CASE ... ELSE col) may not.
function setsConstants(setClause) {
  return splitTopLevel(setClause).every((a) =>
    /^[\w."]+ ?= ?(\?\d*|''|-?\d+(\.\d+)?|NULL|EXCLUDED\.[\w"]+)$/.test(a));
}

// 'read' | 'set' (lands the same rows whatever was there) | 'update' |
// 'delete' | null (not safe to repeat).
export function statementKind(sql) {
  const s = normaliseSql(String(sql || ''));
  if (/^(SELECT|WITH|EXPLAIN)\b/.test(s)) {
    return /\b(INSERT|UPDATE|DELETE)\b|\bREPLACE INTO\b/.test(s) ? null : 'read';
  }
  // A nested SELECT makes a write depend on the rows it is changing:
  // `DELETE ... WHERE id = (SELECT MAX(id) ...)` removes a different row each time.
  if (/\bSELECT\b/.test(s)) return null;
  if (/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS\b/.test(s)) return 'set';
  if (/^(INSERT OR (REPLACE|IGNORE)|REPLACE) INTO\b/.test(s)) return 'set';
  if (/^INSERT INTO\b/.test(s)) {
    if (/\bON CONFLICT\b.*\bDO NOTHING\b/.test(s)) return 'set';
    const set = /\bDO UPDATE SET (.*?)(?: WHERE | RETURNING |$)/.exec(s);
    return set && setsConstants(set[1]) ? 'set' : null;
  }
  if (/^UPDATE\b/.test(s)) {
    const set = /\bSET (.*?)(?: WHERE | RETURNING | FROM |$)/.exec(s);
    return set && setsConstants(set[1]) ? 'update' : null;
  }
  if (/^DELETE FROM\b/.test(s)) return 'delete';
  return null;
}

// One statement is safe when its kind is. A batch commits as a unit, and its
// statements can feed each other: [DELETE WHERE x=1, UPDATE SET x=1 WHERE y=2]
// deletes more the second time. So a batch repeats only when every statement
// is a read or a 'set', none of which picks rows by what the others changed.
export function safeToRepeat(sqls) {
  const kinds = sqls.map(statementKind);
  if (kinds.includes(null)) return false;
  return kinds.length === 1 || kinds.every((k) => k === 'read' || k === 'set');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries(sqls, delays, attempt) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const outcome = failureOutcome(err);
      const retry = i < delays.length && (outcome === 'unsent' || (outcome === 'unknown' && safeToRepeat(sqls)));
      if (!retry) {
        // Logged rather than appended: an AbortError's message is read-only.
        if (i > 0) console.warn(`[d1] giving up after ${i} retr${i === 1 ? 'y' : 'ies'}`);
        throw err;
      }
      console.warn(`[d1] ${err.message}; retry ${i + 1}/${delays.length} in ${delays[i] / 1000}s`);
      await sleep(delays[i]);
    }
  }
}

async function post(env, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), D1_TIMEOUT_MS);
  try {
    const res = await fetch(d1Url(env), {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  } finally {
    clearTimeout(t);
  }
}

export async function d1(env, sql, params = [], { retryDelaysMs = D1_RETRY_DELAYS_MS } = {}) {
  const body = await withRetries([sql], retryDelaysMs, async () => {
    const { res, body } = await post(env, { sql, params });
    if (!res.ok || !body || body.success !== true) {
      throw httpFailure(`D1 query failed: HTTP ${res.status} ${JSON.stringify(body && body.errors)}`, res, body);
    }
    return body;
  });
  return (body.result && body.result[0] && body.result[0].results) || [];
}

// Runs several statements as one D1 batch transaction. This is intentionally
// separate from forEachConcurrent below: concurrency is useful for independent
// bulk writes, while a learning outcome and the aggregates derived from it must
// either all commit or all roll back. The REST API's `batch` form has the same
// transactional semantics as D1Database.batch: statements execute in order and
// a failure rolls the batch back. See Cloudflare's Query D1 Database API.
export async function d1Batch(env, statements, { retryDelaysMs = D1_RETRY_DELAYS_MS } = {}) {
  if (!Array.isArray(statements) || !statements.length) return [];
  const payload = {
    batch: statements.map((statement) => ({
      sql: statement.sql,
      params: statement.params || []
    }))
  };
  return withRetries(statements.map((s) => s.sql), retryDelaysMs, async () => {
    const { res, body } = await post(env, payload);
    const results = body && Array.isArray(body.result) ? body.result : [];
    const failed = results.find((result) => result && result.success === false);
    if (!res.ok || !body || body.success !== true || failed) {
      throw httpFailure(`D1 batch failed: HTTP ${res.status} ${JSON.stringify((body && body.errors) || failed)}`, res, body);
    }
    return results.map((result) => (result && result.results) || []);
  });
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

// Multi-row "insert, or update only what changed" for tables whose rows are
// re-sent unchanged most of the time (whole-history refetches). It ends in the
// same state as INSERT OR REPLACE when `cols` are ALL of the table's columns
// and `keyCols` is its only unique key -- the caller's contract -- but D1 bills
// an unchanged row as 0 written rows instead of one per b-tree (3 on a table
// with one secondary index; both measured on production 2026-09-30). A changed
// value is still written, so upstream corrections land exactly as before.
// Table and column names are code-controlled literals, never caller input.
export function upsertChangedSql(table, cols, keyCols, rowCount) {
  const valueCols = cols.filter((c) => !keyCols.includes(c));
  if (!valueCols.length || keyCols.some((c) => !cols.includes(c))) {
    throw new Error(`upsertChangedSql(${table}): key must be a strict subset of the inserted columns`);
  }
  const row = `(${cols.map(() => '?').join(', ')})`;
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${Array(rowCount).fill(row).join(', ')}`
    + ` ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${valueCols.map((c) => `${c} = excluded.${c}`).join(', ')}`
    + ` WHERE ${valueCols.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(' OR ')}`;
}
