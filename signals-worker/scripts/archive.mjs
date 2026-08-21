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
import { laggedCorrelation, slotsForTimestamp, computeSectorCompositeSeries, computeSpreadSeries } from '../worker.js';

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

// Funding/OI history has no dedicated function here anymore: Bybit's
// funding/history and open-interest endpoints (the original plan) turned
// out to require a paid-tier-only access path — a live run confirmed
// api.bybit.com/v5/market/tickers itself now returns HTTP 403 from GitHub
// Actions, and technique_reliability had zero 'positioning' rows across its
// entire lifetime, meaning Bybit funding had silently never worked at all
// since the reliability system shipped. Replaced with CoinGecko's
// /derivatives listing (see getFundingMap in worker.js) for the *live*
// snapshot — reusing the pipeline's already-proven-reliable primary
// dependency instead of a second unproven exchange. That endpoint has no
// history equivalent, so funding_rate_daily has no deep-backfill path the
// way asset_daily_bars does: depth grows the same way the ~29% CoinGecko-
// fallback slice of the price archive does — one real snapshot logged per
// day, starting from whenever daily-refresh.mjs first runs, accumulating
// forward from there. See appendTodaysFundingSnapshot below.
export function fundingSnapshotToRows(fundingMap, date) {
  const rows = [];
  for (const [symbol, v] of Object.entries(fundingMap || {})) {
    if (v.fundingRate == null && v.openInterest == null) continue;
    rows.push({ symbol, date, fundingRate: v.fundingRate ?? null, openInterest: v.openInterest ?? null, source: 'coingecko' });
  }
  return rows;
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

// --------------------------- IMPLIED VOLATILITY -----------------------------
// Deribit's DVOL index — confirmed live keyless/free, BTC and ETH only (the
// only two currencies Deribit publishes it for; a longer tail of altcoins
// has no equivalent). One call per currency returns real daily history
// back to 2023-11-14 already (capped at 1000 points/request), so a
// symbol's first write bootstraps ~2.75 years at once. `[timestamp_ms,
// open, high, low, close]` per point (unlike DeFiLlama's unix-SECONDS
// convention above) — close (index 4) is this function's own "today's
// implied vol" reading.
export async function fetchDeribitDvolHistory(currency) {
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${encodeURIComponent(currency)}&start_timestamp=0&end_timestamp=${Date.now()}&resolution=86400`;
  const j = await fetchJson(url);
  const points = (j && j.result && j.result.data) || [];
  return points
    .filter((p) => Array.isArray(p) && p.length >= 5 && typeof p[4] === 'number')
    .map((p) => ({ date: new Date(p[0]).toISOString().slice(0, 10), dvol: p[4] }));
}

export async function upsertIvDaily(env, symbol, rows, source = 'deribit') {
  if (!rows.length) return 0;
  let written = 0;
  for (const batch of chunk(rows, 20)) {
    const placeholders = batch.map(() => '(?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [symbol, r.date, r.dvol, source]);
    await d1(env, `INSERT OR IGNORE INTO iv_daily (symbol, date, dvol, source) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// Yahoo options chain, one stock at a time — unlike Deribit's DVOL or
// DeFiLlama's TVL (both return a full backfillable history in one call),
// this endpoint is a live snapshot only, so iv_daily for stocks builds up
// one point per symbol per day. loadIvHistory's existing
// FUNDING_HISTORY_MIN_DAYS gate (reliability.mjs) already handles "not
// enough days yet" with zero changes needed here — same gradual-bootstrap
// shape funding history itself went through. Distilled to the front-month
// (soonest expiration — Yahoo's default when no `date` param is passed)
// call option whose strike sits closest to the live underlying price: one
// ATM-ish IV number, not the full per-strike chain, same "distilled
// signal" discipline as DVOL/TVL. Reuses the exact crumb/cookie handshake
// already proven live in production via getValuation's quoteSummary calls
// (getCrumb, worker.js) — same auth, a genuinely separate endpoint/fetch
// with no existing call to fold this into.
export async function fetchStockAtmIv(symbol, auth) {
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', Cookie: auth.cookie } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const r = j && j.optionChain && j.optionChain.result && j.optionChain.result[0];
  const price = (r && r.quote && typeof r.quote.regularMarketPrice === 'number') ? r.quote.regularMarketPrice : null;
  const chain = r && Array.isArray(r.options) ? r.options[0] : null;
  const calls = (chain && Array.isArray(chain.calls)) ? chain.calls : [];
  if (price == null || !calls.length) return null;
  let best = null, bestDist = Infinity;
  for (const c of calls) {
    if (typeof c.strike !== 'number' || typeof c.impliedVolatility !== 'number') continue;
    const dist = Math.abs(c.strike - price);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best ? best.impliedVolatility : null;
}

// ----------------------------- SENTIMENT ------------------------------------
// Four sources, three of them free-and-keyless, combined into one daily
// archive row per date (market-wide fields) or (date, symbol) (per-asset
// fields) — see sentiment_daily in schema.sql. CMC_API_KEY and
// CRYPTOPANIC_API_TOKEN are optional: both sources simply produce nothing
// when the corresponding env var is unset, same "additive, never load-
// bearing" pattern as TREFIS_OVERRIDES/FCS_D1_DATABASE_ID elsewhere in this
// pipeline — the sentiment technique degrades to whichever fields exist.

// alternative.me's Fear & Greed index goes back to 2018-02-01 in a SINGLE
// call with limit=0 (confirmed live: 3,101 daily points, one request) —
// genuinely deep history, no pagination needed, unlike almost everything
// else in this archive.
export async function fearGreedHistory(limit = 0) {
  const j = await fetchJson(`https://api.alternative.me/fng/?limit=${limit}`);
  const rows = (j && j.data) || [];
  return rows
    .map((r) => ({ date: new Date(Number(r.timestamp) * 1000).toISOString().slice(0, 10), value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value));
}

// CoinGecko's per-coin detail endpoint (NOT the bulk /markets one already
// used hourly) carries a community up/down-vote split — a real but thin
// signal (a poll, not sentiment analysis), which is exactly why it's
// pooled with the other sources rather than trusted alone. One call per
// coin, so this stays in the daily job, not the hourly one.
//
// Retries on 429 with backoff, same pattern (and same backoff schedule) as
// getCryptoDailyHistory's per-coin history calls in worker.js — confirmed
// live that this specific per-coin-detail endpoint is meaningfully more
// rate-limit-sensitive than the bulk /markets endpoint (70 of 73 calls
// 429'd at the daily job's original 300ms pacing); the caller
// (daily-refresh.mjs) also paces more conservatively now, matching
// CRYPTO_HISTORY_DELAY_MS's already-proven-safe value.
// Returns { up, categories }: the sentiment vote plus this same response's
// `categories` array (CoinGecko's raw ~850-string taxonomy, e.g.
// "Decentralized Finance (DeFi)", "Governance") — reused by the daily
// sector-taxonomy step (see mapCategoriesToSectors in worker.js) so that
// step costs zero additional fetches, not a second per-coin call.
export async function coingeckoSentiment(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}`
    + '?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false';
  const backoffsMs = [3000, 6000];
  let lastErr;
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      const j = await fetchJson(url);
      const up = Number(j && j.sentiment_votes_up_percentage);
      const categories = Array.isArray(j && j.categories) ? j.categories : [];
      return { up: Number.isFinite(up) ? up : null, categories };
    } catch (e) {
      lastErr = e;
      const is429 = /^HTTP 429/.test(String(e && e.message));
      if (!is429 || attempt === backoffsMs.length) throw lastErr;
      await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
    }
  }
  throw lastErr;
}

// CoinMarketCap's independently-calculated Fear & Greed Index — a second
// cross-check against alternative.me's, not a replacement for it. Requires
// a free CMC_API_KEY (coinmarketcap.com/api); returns null rather than
// throwing when unset so callers can no-op cleanly. Endpoint/response
// shape follows CMC's documented v3 fear-and-greed/latest — not yet
// exercised live against a real key, so log-and-continue on an unexpected
// shape rather than letting one bad response take down the whole daily run.
export async function cmcFearGreed(apiKey) {
  if (!apiKey) return null;
  const res = await fetch('https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest', {
    headers: { 'X-CMC_PRO_API_KEY': apiKey, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}`);
  const j = await res.json();
  const value = Number(j && j.data && j.data.value);
  if (!Number.isFinite(value)) {
    console.error('cmcFearGreed: unexpected response shape:', JSON.stringify(j).slice(0, 200));
    return null;
  }
  return value;
}

// CryptoPanic's per-currency news feed, community-tagged bullish/bearish —
// real news sentiment, not a price-derived proxy, which is what makes it
// genuinely additive here. Requires a free CRYPTOPANIC_API_TOKEN
// (cryptopanic.com/developers/api); returns null when unset. Reduces a
// page of posts to a single -1..1 score: (bullish - bearish) / (bullish +
// bearish) votes, 0 when a currency has posts but no votes either way, null
// when it has no posts at all this pull (not the same thing — "no signal"
// vs. "neutral signal" stay distinguishable). Response shape/auth style
// (auth_token query param, CryptoPanic's documented v1 approach) has not
// been exercised live — same log-and-continue discipline as cmcFearGreed.
export async function cryptoPanicSentiment(symbol, apiToken) {
  if (!apiToken) return null;
  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${encodeURIComponent(apiToken)}&currencies=${encodeURIComponent(symbol)}&public=true`;
  const j = await fetchJson(url);
  const results = (j && j.results) || [];
  if (!results.length) return null;
  let bullish = 0, bearish = 0;
  for (const post of results) {
    const votes = post.votes || {};
    bullish += Number(votes.positive || votes.liked || 0);
    bearish += Number(votes.negative || votes.disliked || votes.toxic || 0);
  }
  if (bullish + bearish === 0) return 0;
  return (bullish - bearish) / (bullish + bearish);
}

// Upserts market-wide sentiment fields onto the symbol='' sentinel row for
// `date` — merges field-by-field (COALESCE) so the hourly job's F&G/VIX
// write and the daily job's CMC write don't clobber each other regardless
// of which runs first on a given day.
export async function upsertMarketSentiment(env, date, { fearGreedAltme, fearGreedCmc, vixRangePos } = {}) {
  await d1(env, `
    INSERT INTO sentiment_daily (date, symbol, fear_greed_altme, fear_greed_cmc, vix_range_pos)
    VALUES (?, '', ?, ?, ?)
    ON CONFLICT (date, symbol) DO UPDATE SET
      fear_greed_altme = COALESCE(excluded.fear_greed_altme, sentiment_daily.fear_greed_altme),
      fear_greed_cmc = COALESCE(excluded.fear_greed_cmc, sentiment_daily.fear_greed_cmc),
      vix_range_pos = COALESCE(excluded.vix_range_pos, sentiment_daily.vix_range_pos)
  `, [date, fearGreedAltme ?? null, fearGreedCmc ?? null, vixRangePos ?? null]);
}

// Bulk-insert historical Fear & Greed onto the symbol='' sentinel row per
// date — used once by backfill-history.mjs's deep F&G pull. INSERT OR
// IGNORE (not UPSERT) since this only ever fills in dates that don't exist
// yet; today's own row is owned by upsertMarketSentiment above.
export async function insertFearGreedHistory(env, rows) {
  let attempted = 0;
  for (const batch of chunk(rows, 20)) {
    const placeholders = batch.map(() => "(?, '', ?)").join(',');
    const params = batch.flatMap((r) => [r.date, r.value]);
    await d1(env, `INSERT OR IGNORE INTO sentiment_daily (date, symbol, fear_greed_altme) VALUES ${placeholders}`, params);
    attempted += batch.length;
  }
  return attempted;
}

// Upserts per-asset sentiment fields for `date` — same field-by-field
// COALESCE merge as upsertMarketSentiment, for the same reason.
export async function upsertAssetSentiment(env, date, rows) {
  let attempted = 0;
  for (const batch of chunk(rows, 15)) {
    const placeholders = batch.map(() => '(?, ?, ?, ?)').join(',');
    const params = batch.flatMap((r) => [date, r.symbol, r.coingeckoUpPct ?? null, r.cryptopanicScore ?? null]);
    await d1(env, `
      INSERT INTO sentiment_daily (date, symbol, coingecko_up_pct, cryptopanic_score)
      VALUES ${placeholders}
      ON CONFLICT (date, symbol) DO UPDATE SET
        coingecko_up_pct = COALESCE(excluded.coingecko_up_pct, sentiment_daily.coingecko_up_pct),
        cryptopanic_score = COALESCE(excluded.cryptopanic_score, sentiment_daily.cryptopanic_score)
    `, params);
    attempted += batch.length;
  }
  return attempted;
}

// ----------------------------- CROSS-ASSET LEAD/LAG -------------------------

// Every ordered (leader, follower) pair is tested at each of these lags
// (days) and the strongest is kept, once it clears both bars below —
// mirrors this engine's existing "no data or no real signal -> abstain"
// discipline rather than reporting a weak/coincidental best-of-several.
const LEAD_LAG_LAGS = [1, 2, 3, 4, 5, 7, 10];
const LEAD_LAG_MIN_ABS_CORR = 0.5;
const LEAD_LAG_MIN_SAMPLES = 180;

// A single-day return this extreme is essentially always a data artifact,
// not a real move, for anything liquid enough to clear this pipeline's own
// mcap/volume gates — confirmed live by tracing several: Yahoo's UNI-USD
// sat at a stuck ~$0.000038 with volume=3 for days in Oct 2022 then jumped
// to a real-ish price (+1,573,986% in one day), same "stuck-then-jump"
// pattern independently found on CC/GRAM/WLD, and even AAVE has one
// (+10,189%, Oct 2020) — a real, recurring Yahoo data-quality issue, not a
// one-off. 2000% (a 21x move) is well above any genuine single-day move
// for an asset that clears CRYPTO_MIN_MCAP/CRYPTO_MIN_VOLUME.
const IMPLAUSIBLE_DAILY_RETURN_PCT = 2000;

// Shared by computeLeadLag and computeSectorComposites below: turns
// date-sorted (symbol, date, close) rows into a { symbol: { date: pctReturn } }
// map. One implementation of "how do we turn bars into returns," not two
// copies that could drift apart. Skips (rather than clamps) a day whose
// implied return is implausible (see IMPLAUSIBLE_DAILY_RETURN_PCT above) —
// treated as missing data for that (symbol, date), same as if the
// underlying bar were absent, not replaced with a fabricated capped value.
export function barsRowsToReturnsBySymbol(rows) {
  const barsBySymbol = {};
  for (const r of rows) (barsBySymbol[r.symbol] ??= []).push(r);

  const returnsBySymbol = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    if (bars.length < 2) continue;
    const rets = {};
    for (let i = 1; i < bars.length; i++) {
      if (!bars[i - 1].close) continue;
      const ret = (bars[i].close / bars[i - 1].close - 1) * 100;
      if (Math.abs(ret) > IMPLAUSIBLE_DAILY_RETURN_PCT) continue;
      rets[bars[i].date] = ret;
    }
    returnsBySymbol[symbol] = rets;
  }
  return returnsBySymbol;
}

// Bulk-reads the ENTIRE asset_daily_bars archive once (a full-table scan,
// but cheap even at real scale relative to D1's 5M-rows-read/day cap — see
// the plan's own sizing) and tests every ordered pair in memory — the
// expensive part of O(n^2) pairs is per-pair D1 round-trips, which loading
// once avoids entirely; the arithmetic itself is trivial even at a few
// hundred symbols (tens of thousands of ordered pairs × a handful of lags
// each, all plain JS after the one read). This also naturally includes any
// SECTOR:<name> composite pseudo-symbols already written by
// computeSectorComposites (below) as just more rows in the same table, so
// sector-leads-sector and sector-leads-asset relationships fall out of this
// same O(n^2) pass for free — no separate sector-lead-lag engine needed.
export async function computeLeadLag(env) {
  const rows = await d1(env, 'SELECT symbol, date, close FROM asset_daily_bars ORDER BY symbol, date');
  const returnsBySymbol = barsRowsToReturnsBySymbol(rows);

  const symbols = Object.keys(returnsBySymbol);
  const signals = [];
  for (const leader of symbols) {
    for (const follower of symbols) {
      if (leader === follower) continue;
      let best = null;
      for (const lag of LEAD_LAG_LAGS) {
        const r = laggedCorrelation(returnsBySymbol[leader], returnsBySymbol[follower], lag);
        if (!r || r.samples < LEAD_LAG_MIN_SAMPLES) continue;
        if (!best || Math.abs(r.corr) > Math.abs(best.corr)) best = { lag, ...r };
      }
      if (best && Math.abs(best.corr) >= LEAD_LAG_MIN_ABS_CORR) {
        signals.push({ leaderSymbol: leader, followerSymbol: follower, lagDays: best.lag, corr: best.corr, samples: best.samples });
      }
    }
  }
  return signals;
}

// Wholesale replace, not upsert: a relationship that no longer clears the
// significance bar should disappear from the table, not linger from a
// stale prior computation — this recomputes the full current set fresh
// every run (see computeLeadLag above) and swaps it in atomically-enough
// for this purpose (delete-then-insert; a reader mid-way through would see
// an empty or partial table for a moment, acceptable for a technique that
// already treats "no registered leader" as a normal abstain case).
export async function replaceLeadLagSignals(env, signals, computedAt) {
  await d1(env, 'DELETE FROM lead_lag_signals');
  let written = 0;
  for (const batch of chunk(signals, 12)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((s) => [s.leaderSymbol, s.followerSymbol, s.lagDays, s.corr, s.samples, s.samples, computedAt]);
    await d1(env, `INSERT INTO lead_lag_signals (leader_symbol, follower_symbol, lag_days, corr, window_days, samples, computed_at) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// ------------------------- SUPPORT/RESISTANCE (srbreak) ---------------------
// Added after a post-mortem on the 2026-08-19 crypto pump found BTC's
// composite score suppressed through the entire ~7% move by chop-era
// blended technique_reliability (see schema.sql's docs on
// asset_sr_levels/sr_break_stats for the full finding). Rather than touch
// that weighting — it's working as designed — this gives a fresh
// technique_id (worker.js's 'srbreak') no chop-era baggage: it earns its
// own weight from real level-break outcomes computed here.
const SR_PIVOT_LOOKBACK = 5;          // bars each side a pivot must beat to count
const SR_CLUSTER_TOLERANCE_PCT = 1.5; // how close two pivots must be to count as "the same level"
const SR_BREAK_BUFFER_PCT = 0.75;     // close must clear a level by this much — a wick through isn't a break
const SR_MIN_BARS = 60;               // need a real amount of history before trusting any pivot
const SR_MIN_TOUCHES = 2;             // not "key" until price has reversed off it more than once
const SR_MAX_LEVELS_PER_SIDE = 4;     // keep only the strongest few per symbol
const SR_HORIZONS_HOURS = [24, 168];  // matches HORIZONS_HOURS in reliability.mjs; daily bars, so +1/+7 index steps

// Local high/low pivots in a date-sorted, already-return-filtered bars
// array. Uses real high/low where the archive has them (the ~71% of
// crypto sourced from Yahoo, plus all equities); falls back to close for
// the CoinGecko-fallback minority (high/low NULL) — same quality split
// bestVolLookback/seasonalAnalog already accept via their haveDaily gate
// elsewhere in this engine. Strict inequality against every other bar in
// the window, so a flat top/bottom correctly produces no pivot at all
// rather than an arbitrary tie-break.
export function findPivots(bars) {
  const pivots = [];
  const n = bars.length;
  for (let i = SR_PIVOT_LOOKBACK; i < n - SR_PIVOT_LOOKBACK; i++) {
    const hi = bars[i].high ?? bars[i].close;
    const lo = bars[i].low ?? bars[i].close;
    let isHigh = true, isLow = true;
    for (let j = i - SR_PIVOT_LOOKBACK; j <= i + SR_PIVOT_LOOKBACK; j++) {
      if (j === i) continue;
      if ((bars[j].high ?? bars[j].close) >= hi) isHigh = false;
      if ((bars[j].low ?? bars[j].close) <= lo) isLow = false;
    }
    if (isHigh) pivots.push({ i, type: 'resistance', price: hi });
    if (isLow) pivots.push({ i, type: 'support', price: lo });
  }
  return pivots;
}

// Walk-forward, no-lookahead: clusters pivots into levels as they're
// discovered in chronological order (a level only becomes "key" once a
// SECOND pivot lands within SR_CLUSTER_TOLERANCE_PCT of the first — never
// before that point in history), then watches every subsequent bar for a
// decisive close through an already-key level. Each break fires once per
// level (marked broken and retired — the same "don't double-count the same
// underlying event" discipline evaluateMatured's seenMoves uses) and
// records the realized move SR_HORIZONS_HOURS later for calibration.
// Returns the still-open (unbroken) key levels for the live payload, plus
// every historical break event found, for sr_break_stats.
export function walkSrLevels(symbol, assetClass, bars) {
  const clusters = []; // { type, price, touches, firstIdx, lastIdx, broken }
  const breaks = [];

  // findPivots needs SR_PIVOT_LOOKBACK bars on BOTH sides to confirm a
  // pivot, so bar i isn't actually knowable as a pivot until i+LOOKBACK —
  // indexed here by that confirmation bar, not the pivot's own bar, so the
  // walk-forward break simulation below never credits a level with a
  // touch, or checks it for a break, using information that wouldn't
  // really have been available yet at the time (the same no-lookahead
  // discipline bestVolLookback's own backtest already holds itself to).
  const pivotsByConfirmIdx = new Map();
  for (const p of findPivots(bars)) {
    const confirmIdx = p.i + SR_PIVOT_LOOKBACK;
    if (!pivotsByConfirmIdx.has(confirmIdx)) pivotsByConfirmIdx.set(confirmIdx, []);
    pivotsByConfirmIdx.get(confirmIdx).push(p);
  }

  for (let i = 0; i < bars.length; i++) {
    for (const p of pivotsByConfirmIdx.get(i) || []) {
      const match = clusters.find((c) => c.type === p.type && !c.broken
        && Math.abs(p.price - c.price) / c.price * 100 <= SR_CLUSTER_TOLERANCE_PCT);
      if (match) { match.touches++; match.lastIdx = p.i; }
      else clusters.push({ type: p.type, price: p.price, touches: 1, firstIdx: p.i, lastIdx: p.i, broken: false });
    }

    const close = bars[i].close;
    for (const c of clusters) {
      if (c.broken || c.touches < SR_MIN_TOUCHES) continue;
      const brokeDown = c.type === 'support' && close < c.price * (1 - SR_BREAK_BUFFER_PCT / 100);
      const brokeUp = c.type === 'resistance' && close > c.price * (1 + SR_BREAK_BUFFER_PCT / 100);
      if (!brokeDown && !brokeUp) continue;
      c.broken = true;
      for (const h of SR_HORIZONS_HOURS) {
        const future = bars[i + (h === 24 ? 1 : 7)];
        if (!future) continue;
        const pct = (future.close / close - 1) * 100;
        breaks.push({ bucketKey: symbol, horizonHours: h, pct });
        breaks.push({ bucketKey: `${assetClass}|${c.type}`, horizonHours: h, pct });
      }
    }
  }

  const keyClusters = clusters.filter((c) => !c.broken && c.touches >= SR_MIN_TOUCHES);
  const bySide = { support: [], resistance: [] };
  for (const c of keyClusters) bySide[c.type].push(c);
  const pickTop = (arr) => arr
    .sort((a, b) => (b.touches - a.touches) || (b.lastIdx - a.lastIdx))
    .slice(0, SR_MAX_LEVELS_PER_SIDE)
    .map((c) => ({ level: c.price, levelType: c.type, touches: c.touches, firstSeen: bars[c.firstIdx].date, lastTouched: bars[c.lastIdx].date }));

  return { levels: [...pickTop(bySide.support), ...pickTop(bySide.resistance)], breaks };
}

// Bulk-reads the full archive once (same cost profile as computeLeadLag's
// own full-table read, cheap relative to D1's daily read budget), drops
// pseudo-symbols (SECTOR:/TVL:/SPREAD:, which have no tradable level to
// break through), and drops implausible single-day moves the same way
// barsRowsToReturnsBySymbol does for lead/lag — so a Yahoo stuck-price-
// then-jump artifact (see IMPLAUSIBLE_DAILY_RETURN_PCT's docs) can't
// fabricate a fake level or a fake break.
export async function computeSrLevelsAndBreaks(env) {
  const rows = await d1(env, `
    SELECT symbol, asset_class, date, close, high, low FROM asset_daily_bars
    WHERE symbol NOT LIKE 'SECTOR:%' AND symbol NOT LIKE 'TVL:%' AND symbol NOT LIKE 'SPREAD:%'
    ORDER BY symbol, date
  `);
  const barsBySymbol = {};
  for (const r of rows) (barsBySymbol[r.symbol] ??= []).push(r);

  const levelsBySymbol = {};
  const allBreaks = [];
  for (const [symbol, rawBars] of Object.entries(barsBySymbol)) {
    if (rawBars.length < SR_MIN_BARS) continue;
    const assetClass = rawBars[0].asset_class;
    const clean = [rawBars[0]];
    for (let i = 1; i < rawBars.length; i++) {
      const prev = clean[clean.length - 1];
      if (!prev.close || Math.abs(rawBars[i].close / prev.close - 1) * 100 > IMPLAUSIBLE_DAILY_RETURN_PCT) continue;
      clean.push(rawBars[i]);
    }
    if (clean.length < SR_MIN_BARS) continue;

    const { levels, breaks } = walkSrLevels(symbol, assetClass, clean);
    if (levels.length) levelsBySymbol[symbol] = levels;
    allBreaks.push(...breaks);
  }
  return { levelsBySymbol, breaks: allBreaks };
}

// Wholesale replace, same rationale as lead_lag_signals — a level that's
// since been invalidated (broken, or superseded by a fresher cluster)
// should disappear, not linger from a stale prior run.
export async function replaceSrLevels(env, levelsBySymbol) {
  await d1(env, 'DELETE FROM asset_sr_levels');
  const updatedAt = new Date().toISOString();
  const allRows = [];
  for (const [symbol, levels] of Object.entries(levelsBySymbol)) {
    for (const lvl of levels) allRows.push({ symbol, ...lvl });
  }
  let written = 0;
  // 10, not 15: this row is 7 columns wide — confirmed live (real D1 400,
  // "too many SQL variables") that 15 x 7 = 105 params exceeds D1's actual
  // per-query bound-parameter limit, unlike every other batched insert in
  // this file, which all stay well under 100 (e.g. upsertDailyBars' 8
  // columns x 10 rows = 80) — matching that same margin here.
  for (const batch of chunk(allRows, 10)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [r.symbol, r.level, r.levelType, r.touches, r.firstSeen, r.lastTouched, updatedAt]);
    await d1(env, `INSERT INTO asset_sr_levels (symbol, level, level_type, touches, first_seen, last_touched, updated_at) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// Wholesale replace, not incremental accumulate — unlike asset_move_stats
// (fed one matured prediction at a time as real time actually passes, so
// it has to accumulate), computeSrLevelsAndBreaks re-derives every break
// event from the complete archive fresh each run; incrementing on top of
// that would double-count the same historical breaks forever. Aggregates
// to (bucket_key, horizon_hours) sums here in memory before one wholesale
// write — same n/sum_pct/sum_pct_sq shape asset_move_stats uses, so
// mean/stdev retrieval works identically, just populated by full-
// recompute-replace like lead_lag_signals instead of streaming upsert.
export async function replaceSrBreakStats(env, breaks) {
  const agg = {};
  for (const b of breaks) {
    const key = `${b.bucketKey}|${b.horizonHours}`;
    const a = (agg[key] ??= { bucketKey: b.bucketKey, horizonHours: b.horizonHours, n: 0, sumPct: 0, sumPctSq: 0 });
    a.n++; a.sumPct += b.pct; a.sumPctSq += b.pct * b.pct;
  }
  await d1(env, 'DELETE FROM sr_break_stats');
  const updatedAt = new Date().toISOString();
  let written = 0;
  // 12, not 15: same D1 bound-parameter ceiling as replaceSrLevels above
  // (confirmed live) — 6 columns x 12 rows = 72, matching this file's
  // established safety margin (e.g. computeSwingTimeTallies' 7 x 12 = 84).
  for (const batch of chunk(Object.values(agg), 12)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [r.bucketKey, r.horizonHours, r.n, r.sumPct, r.sumPctSq, updatedAt]);
    await d1(env, `INSERT INTO sr_break_stats (bucket_key, horizon_hours, n, sum_pct, sum_pct_sq, updated_at) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// ------------------------------ SECTORS -------------------------------------
// Category -> sector membership, recomputed daily from whichever symbols
// the sentiment loop (daily-refresh.mjs) already fetched CoinGecko detail
// for — zero extra fetches (see coingeckoSentiment's categories field
// above). Wholesale replace, not upsert: same "a relationship that no
// longer holds should disappear" reasoning as replaceLeadLagSignals — a
// token's categories rarely change, but should if CoinGecko's do.
const MIN_SECTOR_CONSTITUENTS = 3;

export async function replaceAssetSectors(env, rows) {
  await d1(env, 'DELETE FROM asset_sectors');
  if (!rows.length) return 0;
  let written = 0;
  const updatedAt = new Date().toISOString();
  for (const batch of chunk(rows, 20)) {
    const placeholders = batch.map(() => '(?,?,?)').join(',');
    const params = batch.flatMap((r) => [r.symbol, r.sector, updatedAt]);
    await d1(env, `INSERT INTO asset_sectors (symbol, sector, updated_at) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// The very first time a sector clears MIN_SECTOR_CONSTITUENTS, its whole
// available composite history is computed in one pass (the archive may
// already hold years of it from the backfill); every run after that only
// appends dates after this sector's own last-written point (see the
// `seeds` parameter on computeSectorCompositeSeries) — same "don't redo
// already-done write work" discipline as BACKFILL_ROW_BUDGET/coverage
// checks elsewhere in this pipeline, so daily cost stays roughly constant
// (a 1-2-row append per sector) rather than growing with the archive's
// depth forever.
export async function computeSectorComposites(env, sectorRows, minConstituents = MIN_SECTOR_CONSTITUENTS) {
  const symbolsBySector = {};
  for (const r of sectorRows) (symbolsBySector[r.sector] ??= new Set()).add(r.symbol);
  const allMemberSymbols = [...new Set(sectorRows.map((r) => r.symbol))];
  if (!allMemberSymbols.length) return [];

  const sectorPseudoSymbols = Object.keys(symbolsBySector).map((s) => `SECTOR:${s}`);
  const allSymbols = [...allMemberSymbols, ...sectorPseudoSymbols];
  const placeholders = allSymbols.map(() => '?').join(',');
  const rows = await d1(env, `SELECT symbol, date, close FROM asset_daily_bars WHERE symbol IN (${placeholders}) ORDER BY symbol, date`, allSymbols);

  const barsBySymbol = {};
  for (const r of rows) (barsBySymbol[r.symbol] ??= []).push(r);
  const seeds = {};
  for (const s of Object.keys(symbolsBySector)) {
    const bars = barsBySymbol[`SECTOR:${s}`];
    if (bars && bars.length) seeds[s] = { date: bars[bars.length - 1].date, close: bars[bars.length - 1].close };
  }

  const returnsBySymbol = barsRowsToReturnsBySymbol(rows); // also produces an unused returns entry per SECTOR:<name> pseudo-row; harmless, never read below
  const bySectorArrays = Object.fromEntries(Object.entries(symbolsBySector).map(([sector, syms]) => [sector, [...syms]]));
  const composites = computeSectorCompositeSeries(returnsBySymbol, bySectorArrays, minConstituents, seeds);

  const out = [];
  for (const [sector, series] of Object.entries(composites)) {
    for (const point of series) {
      out.push({ symbol: `SECTOR:${sector}`, assetClass: 'sector', date: point.date, close: point.close, high: null, low: null, volume: null, source: 'composite' });
    }
  }
  return out;
}

// Derived SPREAD:<name> pseudo-symbol (see computeSpreadSeries in worker.js
// for why this needs no seed/incremental logic the way sector composites
// do): reads two already-archived level series and writes their daily
// difference back into asset_daily_bars, same "just another symbol" reuse
// of the lead/lag engine as SECTOR:*. Cheap to recompute in full every
// call — upsertDailyBars is INSERT OR IGNORE, so only genuinely new dates
// land, and there's no compounding state to seed from.
export async function computeYieldSpread(env, symbolA, symbolB, spreadSymbol) {
  const rows = await d1(env, 'SELECT symbol, date, close FROM asset_daily_bars WHERE symbol IN (?, ?) ORDER BY date', [symbolA, symbolB]);
  const closesA = {}, closesB = {};
  for (const r of rows) {
    if (r.symbol === symbolA) closesA[r.date] = r.close;
    else if (r.symbol === symbolB) closesB[r.date] = r.close;
  }
  const series = computeSpreadSeries(closesA, closesB);
  return series.map((p) => ({ symbol: spreadSymbol, assetClass: 'benchmark', date: p.date, close: p.close, high: null, low: null, volume: null, source: 'derived' }));
}

// Most recent `days` closes per symbol from asset_daily_bars, date-sorted
// ascending — lets the leadlag technique (worker.js) compute a registered
// leader's actual recent N-day return at hourly-build time straight from
// the archive, no live re-fetch needed (the archive already has it).
export async function loadRecentBars(env, symbols, days = 15) {
  if (!symbols.length) return {};
  const out = {};
  for (const batch of chunk(symbols, 20)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = await d1(env, `SELECT symbol, date, close FROM asset_daily_bars WHERE symbol IN (${placeholders}) ORDER BY date DESC`, batch);
    const seenPerSymbol = {};
    for (const r of rows) {
      const count = (seenPerSymbol[r.symbol] = (seenPerSymbol[r.symbol] || 0) + 1);
      if (count > days) continue; // DESC order, so anything past `days` is older than we need
      (out[r.symbol] ??= []).push(r);
    }
  }
  for (const symbol of Object.keys(out)) out[symbol].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// ----------------------------- SWING-TIME-OF-DAY ----------------------------
// Not "does this asset tend to move up/down at time X" (time_of_day_stats
// already answers that) — "WHEN in the day does this asset's high/low
// actually tend to land." Bootstrapped once from ~2 years of real Yahoo
// hourly bars, then appended to daily from asset_price_log's own retained
// history (see daily-refresh.mjs) using the exact same day-bucketing logic,
// so the two sources build one consistent statistic, not two different ones.

// Yahoo's intraday chart endpoint, confirmed live to be hard-capped at 730
// days ("must be within the last 730 days" — the actual error message when
// exceeded), unlike the daily endpoint's effectively unlimited depth. 700,
// not 730, for a small safety margin against that boundary.
export async function yahooHourlyBars(ticker, days = 700) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - days * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?period1=${period1}&period2=${period2}&interval=1h`;
  const j = await fetchJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp || !r.timestamp.length) throw new Error('empty chart');
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] != null) bars.push({ ts: new Date(r.timestamp[i] * 1000).toISOString(), close: q.close[i] });
  }
  if (bars.length < 100) throw new Error(`thin intraday history (${bars.length} bars)`);
  return bars;
}

// Groups hourly bars (`{ts, close}`, any order) into UTC calendar days,
// finds each day's max-close and min-close hour, and tallies the slots
// those hours belong to (see slotsForTimestamp in worker.js). Days with
// fewer than 12 of a possible 24 hourly bars (a data gap, or the partial
// first/last day of the fetch window) are skipped rather than trusted —
// a real day's extreme could easily be one of the *missing* hours.
// Pure/no I/O — reused identically by the one-time backfill (Yahoo hourly)
// and the daily forward-tally (asset_price_log rows), so both build the
// same statistic the same way.
export function computeSwingTimeTallies(hourlyBars) {
  const byDay = new Map();
  for (const bar of hourlyBars) {
    const day = bar.ts.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(bar);
  }
  const tallies = {};
  let totalDays = 0;
  for (const dayBars of byDay.values()) {
    if (dayBars.length < 12) continue;
    let hi = dayBars[0], lo = dayBars[0];
    for (const b of dayBars) {
      if (b.close > hi.close) hi = b;
      if (b.close < lo.close) lo = b;
    }
    totalDays++;
    for (const slot of slotsForTimestamp(hi.ts)) {
      (tallies[slot] ??= { high: 0, low: 0 }).high++;
    }
    for (const slot of slotsForTimestamp(lo.ts)) {
      (tallies[slot] ??= { high: 0, low: 0 }).low++;
    }
  }
  return { tallies, totalDays };
}

// Additive upsert: the same slot gets touched by both the one-time
// backfill and every subsequent daily tally, and count/total_days should
// accumulate across all of them, never overwrite.
export async function upsertSwingTimeStats(env, symbol, assetClass, tallies, totalDays, updatedAt) {
  const rows = [];
  for (const [slot, t] of Object.entries(tallies)) {
    if (t.high) rows.push({ slot, extremeType: 'high', count: t.high });
    if (t.low) rows.push({ slot, extremeType: 'low', count: t.low });
  }
  if (!rows.length) return 0;
  let written = 0;
  for (const batch of chunk(rows, 12)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [symbol, assetClass, r.slot, r.extremeType, r.count, totalDays, updatedAt]);
    await d1(env, `
      INSERT INTO swing_time_stats (symbol, asset_class, slot, extreme_type, count, total_days, updated_at)
      VALUES ${placeholders}
      ON CONFLICT (symbol, slot, extreme_type) DO UPDATE SET
        count = swing_time_stats.count + excluded.count,
        total_days = swing_time_stats.total_days + excluded.total_days,
        updated_at = excluded.updated_at
    `, params);
    written += batch.length;
  }
  return written;
}

// Historical-bootstrap counterpart to evaluateTimeOfDay's own live upsert
// (reliability.mjs) — identical ON CONFLICT DO UPDATE SQL, so a symbol's
// deep-history bootstrap and its subsequent daily live tallies accumulate
// into the exact same running total, not two different numbers under the
// same key. tallies: computeTimeOfDayTallies' return shape, "slot|h" ->
// {sumPct, sumPctSq, n}.
export async function upsertTimeOfDayStats(env, symbol, assetClass, tallies, updatedAt) {
  const entries = Object.entries(tallies);
  if (!entries.length) return 0;
  let written = 0;
  for (const batch of chunk(entries, 12)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap(([key, t]) => {
      const [slot, h] = key.split('|');
      return [symbol, assetClass, slot, Number(h), t.n, t.sumPct, t.sumPctSq, updatedAt];
    });
    await d1(env, `
      INSERT INTO time_of_day_stats (symbol, asset_class, slot, horizon_hours, n, sum_pct, sum_pct_sq, updated_at)
      VALUES ${placeholders}
      ON CONFLICT (symbol, slot, horizon_hours) DO UPDATE SET
        n = time_of_day_stats.n + excluded.n,
        sum_pct = time_of_day_stats.sum_pct + excluded.sum_pct,
        sum_pct_sq = time_of_day_stats.sum_pct_sq + excluded.sum_pct_sq,
        updated_at = excluded.updated_at
    `, params);
    written += batch.length;
  }
  return written;
}

// Existing coverage check so the (one-time-ish) backfill doesn't re-fetch
// and re-tally a symbol that's already been bootstrapped — checks the
// symbol's own max total_days across its rows (same value on every row
// for a given symbol, see upsertSwingTimeStats's docs).
export async function getSwingTimeCoverage(env) {
  const rows = await d1(env, 'SELECT symbol, MAX(total_days) AS total_days FROM swing_time_stats GROUP BY symbol');
  return Object.fromEntries(rows.map((r) => [r.symbol, r.total_days]));
}

// ----------------------------- EVENT SEVERITY (HACKS) -----------------------
// DeFiLlama's public hacks tracker — confirmed live: 607 records back to
// 2016-06-17, a real USD `amount` on 594 of them (top five: $3.5B/$1.4B/
// $624M/$611M/$570M). Free, keyless, no pagination needed (one call
// returns the full history to date).
export async function fetchDefiLlamaHacks() {
  const j = await fetchJson('https://api.llama.fi/hacks');
  return (Array.isArray(j) ? j : [])
    .filter((r) => r.date && r.name)
    .map((r) => ({
      date: new Date(r.date * 1000).toISOString().slice(0, 10),
      name: r.name,
      amount: typeof r.amount === 'number' && r.amount > 0 ? r.amount : null,
      classification: r.classification || null,
      technique: r.technique || null
    }));
}

// Conservative on purpose: only an exact (case-insensitive, trimmed) name
// match against the tracked universe counts. A fuzzy/partial match risks
// tagging the WRONG asset with a bearish event, which is worse than
// silently missing a real one — records that don't clearly match keep
// symbol=null (stored for later review, never guessed at).
export function matchHacksToUniverse(hacks, universe) {
  const byName = new Map(universe.map((a) => [a.name.trim().toLowerCase(), a.symbol]));
  return hacks.map((h) => ({ ...h, symbol: byName.get(h.name.trim().toLowerCase()) || null }));
}

export async function upsertAssetEvents(env, events) {
  if (!events.length) return 0;
  let written = 0;
  for (const batch of chunk(events, 10)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((e) => [e.symbol, e.date, 'hack', e.amount, e.name, 'defillama']);
    await d1(env, `INSERT OR IGNORE INTO asset_events (symbol, event_date, event_type, severity_usd, description, source) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// --------------------------- TVL (DeFiLlama) --------------------------------
// Bulk protocol listing — confirmed live: 8,004 protocols, one call, no
// per-protocol cost. `gecko_id` is what makes conservative matching cheap
// and reliable (see matchProtocolsToUniverse below): a real CoinGecko id
// is a precise 1:1 identifier, a stronger guarantee than name-matching
// (which is what fetchDefiLlamaHacks/matchHacksToUniverse above use,
// since DeFiLlama's hacks feed has no id field to match on instead).
// Allowlist, not a blocklist — same conservative "only match what's
// confirmed, leave the rest out" discipline as matchHacksToUniverse/
// matchProtocolsToUniverse below. Found live, the hard way: an earlier,
// category-blind version of this function matched real capital-flow
// protocols (Aave, Uniswap-style DEXs) but ALSO matched chain/bridge/CEX/
// foundation entries DeFiLlama tracks under the same generic /protocols
// endpoint — e.g. BTC matched "bitcoin" (a canonical-bridge tracker) and
// ETH matched "ethereum-foundation" (foundation treasury holdings),
// neither of which has anything to do with "capital flowing into a
// protocol." Checked DeFiLlama's full live category breakdown (2,326
// gecko_id-bearing protocols, 60 distinct categories) and kept only the
// ones that are unambiguously "capital locked/deployed in a protocol,"
// the same concept the tvltrend technique is actually trying to read —
// excluding Chain/Bridge/Canonical Bridge/Cross Chain Bridge/CEX/
// Foundation (confirmed-wrong) and a long tail of ambiguous categories
// (Services, Launchpad, Gaming, AI Agents, etc.) that aren't confidently
// one or the other.
const DEFI_TVL_CATEGORIES = new Set([
  'Dexs', 'Yield', 'Lending', 'Derivatives', 'Farm', 'CDP', 'Algo-Stables',
  'Yield Aggregator', 'Liquid Staking', 'RWA', 'RWA Lending', 'Prediction Market',
  'DEX Aggregator', 'Options', 'Synthetics', 'Insurance', 'Liquidity Manager',
  'NFT Lending', 'Leveraged Farming', 'Staking Pool', 'Basis Trading',
  'Restaking', 'Liquid Restaking', 'Uncollateralized Lending'
]);

export async function fetchDefiLlamaProtocols() {
  const j = await fetchJson('https://api.llama.fi/protocols');
  return (Array.isArray(j) ? j : [])
    .filter((p) => p.slug && p.gecko_id && DEFI_TVL_CATEGORIES.has(p.category))
    .map((p) => ({ slug: p.slug, geckoId: p.gecko_id, name: p.name, category: p.category }));
}

// Conservative on purpose, same discipline as matchHacksToUniverse: only
// an exact gecko_id match counts. `universe` entries need an `id` field
// (the CoinGecko id — see fullUniverse in daily-refresh.mjs).
export function matchProtocolsToUniverse(protocols, universe) {
  const byGeckoId = new Map(universe.map((a) => [a.id, a.symbol]));
  return protocols
    .map((p) => ({ ...p, symbol: byGeckoId.get(p.geckoId) || null }))
    .filter((p) => p.symbol);
}

// Full daily TVL history for one protocol — confirmed live: Aave, 2,273
// points back to 2020-05-19, already one point per calendar day (no
// dedup needed). `date` arrives as unix seconds; converted to the same
// 'YYYY-MM-DD' + close shape upsertDailyBars expects everywhere else.
export async function defiLlamaProtocolTvlHistory(slug) {
  const j = await fetchJson(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`);
  const series = Array.isArray(j && j.tvl) ? j.tvl : [];
  return series
    .filter((p) => p.date && typeof p.totalLiquidityUSD === 'number' && p.totalLiquidityUSD > 0)
    .map((p) => ({ date: new Date(p.date * 1000).toISOString().slice(0, 10), close: p.totalLiquidityUSD }));
}

// Read-back for the hourly build: whichever TVL:<symbol> pseudo-rows exist
// in asset_daily_bars (however many protocols matched on the most recent
// daily-refresh run), most recent `days` bars each — reuses loadRecentBars
// unmodified, same as leaderReturns does for lead/lag leaders. Keys the
// returned map by the real asset symbol, not the TVL: prefix, so the
// tvltrend technique can look it up the same way every other per-symbol
// context map already does (ctx.tvlSeries[m.symbol]).
export async function loadTvlSeries(env, days = 15) {
  const rows = await d1(env, "SELECT DISTINCT symbol FROM asset_daily_bars WHERE symbol LIKE 'TVL:%'");
  if (!rows.length) return {};
  const pseudoSymbols = rows.map((r) => r.symbol);
  const bars = await loadRecentBars(env, pseudoSymbols, days);
  const out = {};
  for (const [pseudo, series] of Object.entries(bars)) out[pseudo.slice(4)] = series;
  return out;
}

// ------------------------- BINANCE.US (SUB-DAILY CRYPTO HISTORY) -----------
// Binance.com is geo-blocked (HTTP 451, "Service unavailable from a
// restricted location according to 'b. Eligibility' in binance.com/en/terms")
// from this project's infrastructure — confirmed live. Binance.US is the
// compliant, reachable alternative, confirmed live too, but its own history
// only reaches back to ~2019-09-23 (the platform's own launch — confirmed
// live as the same floor for every symbol tested, not each coin's real
// individual listing date), not Binance.com's deeper 2017 start.
const BINANCE_US_BASE = 'https://api.binance.us/api/v3';

// Which USDT pairs actually exist and are tradable on Binance.US right
// now — checked against the current crypto watchlist before fetching
// anything, so an uncovered symbol is skipped and logged, not silently
// retried forever or routed through a shallower fallback (see
// backfill-history.mjs's Binance leg for why no CoinGecko-hourly
// fallback: it would be shallower than what the Yahoo-hourly leg already
// gives that symbol for free).
export async function binanceUsExchangeInfo() {
  const j = await fetchJson(`${BINANCE_US_BASE}/exchangeInfo`);
  const pairs = new Set();
  for (const s of (j && j.symbols) || []) {
    if (s.status === 'TRADING' && typeof s.symbol === 'string' && s.symbol.endsWith('USDT')) pairs.add(s.symbol);
  }
  return pairs;
}

// Pure — separated from the paginating fetch loop below so the response
// shape can be unit-tested against a synthetic fixture without a network
// call. `rawRows`: Binance's raw klines array-of-arrays, confirmed live —
// [openTime, open, high, low, close, volume, closeTime, ...], price/volume
// fields as strings, openTime/closeTime as epoch ms.
export function parseBinanceKlines(rawRows) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows.map((r) => ({
    ts: new Date(r[0]).toISOString(),
    close: parseFloat(r[4]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    volume: parseFloat(r[5])
  }));
}

// Paginated forward from startMs to endMs, 1000 candles/request (Binance's
// documented cap). Advances the cursor by the last candle's own openTime
// + 1ms rather than a fixed interval-duration step, so this works
// correctly for any interval without the caller needing to know its
// exact ms length. No internal row/request cap by design — a caller that
// needs a bounded fetch (e.g. a resumable per-run budget) should bound
// startMs/endMs itself rather than this function silently truncating.
export async function binanceUsKlines(pairSymbol, interval, startMs, endMs) {
  const bars = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${BINANCE_US_BASE}/klines?symbol=${encodeURIComponent(pairSymbol)}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rawRows = await fetchJson(url);
    if (!Array.isArray(rawRows) || !rawRows.length) break;
    bars.push(...parseBinanceKlines(rawRows));
    const lastOpenTime = rawRows[rawRows.length - 1][0];
    if (rawRows.length < 1000 || lastOpenTime < cursor) break; // exhausted the range, or no forward progress (defensive)
    cursor = lastOpenTime + 1;
  }
  return bars;
}

// Per-symbol (minBar, maxBar, count) already in asset_hourly_bars — same
// "only fetch/write what's missing" shape as getExistingCoverage above,
// just keyed by bar_at (a timestamp) instead of date.
export async function getExistingHourlyCoverage(env, symbols) {
  if (!symbols.length) return {};
  const rows = await d1(env, 'SELECT symbol, MIN(bar_at) AS minBar, MAX(bar_at) AS maxBar, COUNT(*) AS count FROM asset_hourly_bars GROUP BY symbol');
  const want = new Set(symbols);
  const out = {};
  for (const r of rows) if (want.has(r.symbol)) out[r.symbol] = { minBar: r.minBar, maxBar: r.maxBar, count: r.count };
  return out;
}

// INSERT OR IGNORE keyed by (symbol, bar_at) — same repeat-safe shape as
// upsertDailyBars. 8 cols x 10 rows = 80 params, comfortably under D1's
// confirmed 100-bound-param ceiling.
export async function upsertHourlyBars(env, rows) {
  let attempted = 0;
  for (const batch of chunk(rows, 10)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((b) => [b.symbol, b.assetClass, b.bar_at, b.close, b.high ?? null, b.low ?? null, b.volume ?? null, b.source]);
    await d1(env, `INSERT OR IGNORE INTO asset_hourly_bars (symbol, asset_class, bar_at, close, high, low, volume, source) VALUES ${placeholders}`, params);
    attempted += batch.length;
  }
  return attempted;
}
