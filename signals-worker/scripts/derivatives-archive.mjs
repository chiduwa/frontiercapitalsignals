// Fetch + parse layer for Binance's public data portal (data.binance.vision).
// Pure functions plus thin fetchers, kept separate from the backfill driver
// the same way archive.mjs is separate from backfill-history.mjs.
//
// The portal is a static bucket. It is NOT fapi.binance.com, which is HTTP 451
// from this infra, and NOT api.bybit.com, which is HTTP 403 CloudFront
// country-blocked. It is the same host family as data-api.binance.vision,
// already a proven dependency for crypto daily bars.
import { inflateRawSync } from 'node:zlib';

export const PORTAL = 'https://data.binance.vision/data/futures/um/daily/metrics';

// Binance lists very-low-unit-price assets under a scaled ticker: one
// 1000PEPEUSDT contract is 1000 PEPE. Confirmed live 2026-09-11 for exactly
// these six across the tracked universe; probing four conventions
// (1000X, 1000000X, X-USDC, 1MX) found no others. The scaling matters only for
// oi_qty_close -- oi_usd_* is already denominated in dollars and needs no
// adjustment, which is why the features read the USD column.
export const VENUE_SYMBOL_OVERRIDES = {
  BONK: '1000BONKUSDT', FLOKI: '1000FLOKIUSDT', LUNC: '1000LUNCUSDT',
  PEPE: '1000PEPEUSDT', SHIB: '1000SHIBUSDT', XEC: '1000XECUSDT'
};

export function venueSymbol(symbol) {
  return VENUE_SYMBOL_OVERRIDES[symbol] || `${symbol}USDT`;
}

// Minimal single-entry ZIP reader. Node ships zlib but no ZIP container
// parser, and this project has no runtime dependencies to add one to. Every
// portal metrics archive holds exactly one CSV, so walking the local file
// header is enough: signature, then method at +8, then the two length fields
// that locate the payload. Method 8 is deflate (inflateRaw), 0 is stored.
export function unzipSingleFile(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip (bad local header signature)');
  const method = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  // A streamed zip writes 0 into the size fields and defers them to a data
  // descriptor after the payload; then the payload runs to the central
  // directory, which inflateRaw stops at on its own.
  const end = compressedSize > 0 ? start + compressedSize : buf.length;
  const payload = buf.subarray(start, end);
  if (method === 0) return payload.toString('utf8');
  if (method !== 8) throw new Error(`unsupported zip compression method ${method}`);
  return inflateRawSync(payload).toString('utf8');
}

const NUM = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Collapses one day of 5-minute metric bars into a single daily row.
// `close` is the last bar of the UTC day so it lines up with a daily price
// close; `mean` is carried alongside because a single 5m OI print can be
// distorted by a liquidation cascade that has fully unwound minutes later.
export function aggregateMetricsCsv(csv, { symbol, venue, date, source = 'binance-data-portal' }) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return null;
  const head = lines[0].split(',').map((h) => h.trim());
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const need = ['create_time', 'sum_open_interest', 'sum_open_interest_value'];
  for (const k of need) if (!(k in col)) throw new Error(`metrics csv missing column ${k}`);

  const oiUsd = [], oiQty = [], tAcc = [], tPos = [], aAcc = [], taker = [];
  let lastUsd = null, lastQty = null, lastTime = '';
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length < head.length) continue;
    const t = (f[col.create_time] || '').trim();
    // The portal occasionally includes a stray bar from the neighbouring day;
    // keep the file's own date authoritative rather than trusting the name.
    if (t.slice(0, 10) !== date) continue;
    const usd = NUM(f[col.sum_open_interest_value]);
    const qty = NUM(f[col.sum_open_interest]);
    if (usd != null && usd > 0) { oiUsd.push(usd); if (t >= lastTime) { lastUsd = usd; lastTime = t; } }
    if (qty != null && qty > 0) { oiQty.push(qty); if (t >= lastTime) lastQty = qty; }
    const push = (arr, name) => { if (name in col) { const v = NUM(f[col[name]]); if (v != null && v > 0) arr.push(v); } };
    push(tAcc, 'count_toptrader_long_short_ratio');
    push(tPos, 'sum_toptrader_long_short_ratio');
    push(aAcc, 'count_long_short_ratio');
    push(taker, 'sum_taker_long_short_vol_ratio');
  }
  if (!oiUsd.length) return null;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    symbol, date, venue_symbol: venue,
    oi_usd_close: lastUsd, oi_usd_mean: mean(oiUsd),
    oi_usd_high: Math.max(...oiUsd), oi_usd_low: Math.min(...oiUsd),
    oi_qty_close: lastQty,
    toptrader_account_ls: mean(tAcc), toptrader_position_ls: mean(tPos),
    all_account_ls: mean(aAcc), taker_buy_sell_ratio: mean(taker),
    samples: oiUsd.length, source
  };
}

// 404 is an ordinary, expected answer here: the portal only has files from a
// contract's listing date onward, and gaps exist. It is returned as null so
// the caller can distinguish "no data for this day" from a transport failure
// worth retrying -- the same abstain-vs-error split the rest of this engine
// uses. 451/403 would mean the portal has started geo-blocking too and must
// surface loudly rather than being silently swallowed as "no data".
export async function fetchMetricsDay(symbol, date, { timeoutMs = 25000, retries = 2 } = {}) {
  const venue = venueSymbol(symbol);
  const url = `${PORTAL}/${venue}/${venue}-metrics-${date}.zip`;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 404) return null;
      if (res.status === 451 || res.status === 403) throw new Error(`portal blocked: HTTP ${res.status} for ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return aggregateMetricsCsv(unzipSingleFile(buf), { symbol, venue, date });
    } catch (e) {
      lastErr = e;
      if (/portal blocked/.test(String(e && e.message))) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export const DERIV_COLUMNS = [
  'symbol', 'date', 'venue_symbol', 'oi_usd_close', 'oi_usd_mean', 'oi_usd_high', 'oi_usd_low',
  'oi_qty_close', 'toptrader_account_ls', 'toptrader_position_ls', 'all_account_ls',
  'taker_buy_sell_ratio', 'samples', 'source'
];

// One multi-row INSERT rather than one statement per row. D1's REST latency is
// per REQUEST, not per statement (see d1-client.mjs), so rows-per-request is
// what sets throughput.
//
// The binding cap that matters here is D1's, NOT SQLite's: D1 allows at most
// 100 bound parameters per STATEMENT, well below SQLite's own 999 default.
// Found the hard way — 60 rows x 14 columns = 840 params came back
// "too many SQL variables" (SQLITE_ERROR 7500). 7 x 14 = 98 is the largest
// multi-row insert that fits. Throughput is recovered by putting many such
// statements into one batch request instead (see writeRows), since the cap is
// per statement and not per batch.
export const DERIV_MAX_BOUND_PARAMS = 100;
export const DERIV_ROWS_PER_STATEMENT = Math.floor(DERIV_MAX_BOUND_PARAMS / 14);

export function buildDerivInsert(rows) {
  const cols = DERIV_COLUMNS.join(', ');
  const placeholder = `(${DERIV_COLUMNS.map(() => '?').join(', ')})`;
  const sql = `INSERT INTO derivatives_daily (${cols}) VALUES ${rows.map(() => placeholder).join(', ')}\n`
    + `ON CONFLICT(symbol, date) DO UPDATE SET `
    + DERIV_COLUMNS.filter((c) => c !== 'symbol' && c !== 'date')
      .map((c) => `${c} = excluded.${c}`).join(', ');
  const params = [];
  for (const r of rows) for (const c of DERIV_COLUMNS) params.push(r[c] === undefined ? null : r[c]);
  return { sql, params };
}

export function dateRange(fromISO, toISO) {
  const out = [];
  for (let t = Date.parse(`${fromISO}T00:00:00Z`); t <= Date.parse(`${toISO}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
