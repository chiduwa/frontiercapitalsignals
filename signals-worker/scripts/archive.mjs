// Fetch + D1-write helpers for the permanent historical archive (see the
// new tables at the bottom of schema.sql). Shared by backfill-history.mjs
// (one-time/resumable deep backfill) and daily-refresh.mjs (cheap daily
// append), so there's one implementation of "how do we get a symbol's full
// price history" and "how do we write a daily bar," not two copies that
// could drift apart.
//
// Deliberately separate from worker.js's own fetch helpers (yahooDaily,
// getCryptoDailyHistory, etc.): those are tuned for the hourly job's needs
// (a bounded working window, fast, every hour) and this module's job is the
// opposite (unbounded depth, infrequent, feeds the archive not live scoring)
// — reusing them would mean fighting their bounded-range design rather than
// saving real code. worker.js's getCryptoMarkets/getFundingMap ARE reused
// directly (see backfill-history.mjs/daily-refresh.mjs imports) since those
// two are genuinely the same need either way: "what's in the universe" and
// "what's each coin's live funding right now."
import { d1, chunk } from './d1-client.mjs';

const UA = 'Mozilla/5.0 (compatible; FrontierCapitalSignals/2.0)';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Full available daily history for one Yahoo ticker (crypto: `${SYM}-USD`,
// equities: the plain ticker). Explicit period1=0/period2=now, NOT
// `range=max` — confirmed live during planning that `range=max&interval=1d`
// silently coarsens to ~monthly bars once the span gets long (144 points
// spanning 11+ years for BTC-USD, ~30-day gaps between them), while explicit
// epoch bounds return genuine daily granularity for the entire available
// span (4,324 real daily bars back to 2014-10-01 for BTC-USD; 11,500 back to
// AAPL's 1980 listing). This is the one function in the whole archive
// subsystem that must never switch back to `range=`.
export async function yahooFullHistory(ticker) {
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=0&period2=${period2}&interval=1d`;
  const j = await fetchJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.timestamp.length) throw new Error('empty chart');
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] != null) {
      bars.push({
        date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
        close: q.close[i],
        high: q.high[i] != null ? q.high[i] : q.close[i],
        low: q.low[i] != null ? q.low[i] : q.close[i],
        volume: q.volume[i] != null ? q.volume[i] : null
      });
    }
  }
  if (bars.length < 30) throw new Error(`thin history (${bars.length} bars)`);
  return bars;
}

// CoinGecko fallback for the ~29% of the crypto universe Yahoo doesn't
// carry (measured during planning) — same 365-day free-tier ceiling as
// worker.js's getCryptoDailyHistory, but this variant keeps the real
// per-point timestamp (getCryptoDailyHistory discards it, since the hourly
// job only ever needs a plain closes[] array) since the archive table needs
// a real calendar date per row.
export async function coingeckoDailyBars(id, days = 365) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart`
    + `?vs_currency=usd&days=${days}&interval=daily`;
  const j = await fetchJson(url);
  const prices = (j && j.prices) || [];
  const volByTs = new Map(((j && j.total_volumes) || []).map(([t, v]) => [t, v]));
  const byDate = new Map();
  for (const [ts, price] of prices) {
    if (price == null) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    byDate.set(date, { date, close: price, high: null, low: null, volume: volByTs.get(ts) ?? null });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 30) throw new Error(`thin history (${bars.length} bars)`);
  return bars;
}

// Bybit funding-rate history, paginated backward via endTime until either
// `sinceMs` is reached or the exchange runs out of history for this
// contract (whichever's first — most perps don't go back a full year).
// NOTE: response shape (`result.list[].fundingRateTimestamp/.fundingRate`)
// follows Bybit's documented v5 API and mirrors the already-proven-live
// ticker endpoint's field-naming convention, but this specific endpoint has
// not been exercised live yet (see the plan) — logs a truncated raw
// response on an unexpected shape so the first real run is debuggable
// rather than silently wrong.
export async function bybitFundingHistory(contractSymbol, sinceMs, maxPages = 40) {
  const out = [];
  let endTime = Date.now();
  for (let page = 0; page < maxPages; page++) {
    const url = `https://api.bybit.com/v5/market/funding/history`
      + `?category=linear&symbol=${encodeURIComponent(contractSymbol)}&endTime=${endTime}&limit=200`;
    const j = await fetchJson(url);
    if (j.retCode !== 0) throw new Error(`Bybit retCode ${j.retCode}: ${j.retMsg}`);
    const rows = (j.result && j.result.list) || [];
    if (!rows.length) break;
    for (const row of rows) {
      const ts = Number(row.fundingRateTimestamp);
      const rate = Number(row.fundingRate);
      if (!Number.isFinite(ts) || !Number.isFinite(rate)) {
        console.error(`bybitFundingHistory: unexpected row shape for ${contractSymbol}:`, JSON.stringify(row).slice(0, 200));
        continue;
      }
      out.push({ ts, date: new Date(ts).toISOString().slice(0, 10), fundingRate: rate });
    }
    const oldest = Math.min(...rows.map((r) => Number(r.fundingRateTimestamp)));
    if (!Number.isFinite(oldest) || oldest <= sinceMs) break;
    endTime = oldest - 1;
    await new Promise((res) => setTimeout(res, 250));
  }
  // Multiple funding events/day (most perps: every 8h) collapse to one
  // archive row per day — mean of that day's rates, which is what a
  // "today's funding level" read should mean at daily grain.
  const byDate = new Map();
  for (const f of out) {
    const cur = byDate.get(f.date);
    if (!cur) byDate.set(f.date, { sum: f.fundingRate, n: 1 });
    else { cur.sum += f.fundingRate; cur.n += 1; }
  }
  return [...byDate.entries()].map(([date, v]) => ({ date, fundingRate: v.sum / v.n }));
}

// Bybit open interest, daily granularity, most-recent window only (this
// endpoint's lookback is short regardless of pagination per Bybit's docs —
// depth here comes from accumulating one call/day going forward via
// daily-refresh.mjs, same pattern as everything else in this archive).
// Same shape-uncertainty caveat as bybitFundingHistory above.
export async function bybitOpenInterest(contractSymbol) {
  const url = `https://api.bybit.com/v5/market/open-interest`
    + `?category=linear&symbol=${encodeURIComponent(contractSymbol)}&intervalTime=1d&limit=200`;
  const j = await fetchJson(url);
  if (j.retCode !== 0) throw new Error(`Bybit retCode ${j.retCode}: ${j.retMsg}`);
  const rows = (j.result && j.result.list) || [];
  const out = [];
  for (const row of rows) {
    const ts = Number(row.timestamp);
    const oi = Number(row.openInterest);
    if (!Number.isFinite(ts) || !Number.isFinite(oi)) {
      console.error(`bybitOpenInterest: unexpected row shape for ${contractSymbol}:`, JSON.stringify(row).slice(0, 200));
      continue;
    }
    out.push({ date: new Date(ts).toISOString().slice(0, 10), openInterest: oi });
  }
  return out;
}

// Per-symbol (minDate, maxDate, count) already in asset_daily_bars — lets
// callers only fetch/write what's actually missing instead of re-pulling
// full history every run. One full-table aggregate scan (cheap at this
// scale, and infrequent — once per backfill/daily-refresh invocation).
export async function getExistingCoverage(env, symbols) {
  const rows = await d1(env, 'SELECT symbol, MIN(date) AS minDate, MAX(date) AS maxDate, COUNT(*) AS count FROM asset_daily_bars GROUP BY symbol');
  const want = new Set(symbols);
  const out = {};
  for (const r of rows) if (want.has(r.symbol)) out[r.symbol] = { minDate: r.minDate, maxDate: r.maxDate, count: r.count };
  return out;
}

// INSERT OR IGNORE keyed by (symbol, date) — safe to call repeatedly with
// overlapping data, only genuinely-new dates land. Returns an approximate
// rows-attempted count (D1's REST API doesn't cleanly surface per-statement
// affected-row counts through the shared d1() client) — good enough for a
// soft write-budget guard, which is this number's only job.
export async function upsertDailyBars(env, rows) {
  let attempted = 0;
  for (const batch of chunk(rows, 10)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((b) => [b.symbol, b.assetClass, b.date, b.close, b.high ?? null, b.low ?? null, b.volume ?? null, b.source]);
    await d1(env, `INSERT OR IGNORE INTO asset_daily_bars (symbol, asset_class, date, close, high, low, volume, source) VALUES ${placeholders}`, params);
    attempted += batch.length;
  }
  return attempted;
}

// Upsert funding/OI, merging per (symbol, date): a funding-only row and an
// OI-only row for the same day (they come from two separate Bybit calls)
// both land on the same archive row rather than overwriting each other.
export async function upsertFundingDaily(env, rows) {
  let attempted = 0;
  for (const batch of chunk(rows, 12)) {
    const placeholders = batch.map(() => '(?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [r.symbol, r.date, r.fundingRate ?? null, r.openInterest ?? null, r.source]);
    await d1(env, `
      INSERT INTO funding_rate_daily (symbol, date, funding_rate, open_interest, source)
      VALUES ${placeholders}
      ON CONFLICT(symbol, date) DO UPDATE SET
        funding_rate = COALESCE(excluded.funding_rate, funding_rate_daily.funding_rate),
        open_interest = COALESCE(excluded.open_interest, funding_rate_daily.open_interest)
    `, params);
    attempted += batch.length;
  }
  return attempted;
}
