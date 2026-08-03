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
import { laggedCorrelation, slotsForTimestamp } from '../worker.js';

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
export async function coingeckoSentiment(id) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}`
    + '?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false';
  const backoffsMs = [3000, 6000];
  let lastErr;
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      const j = await fetchJson(url);
      const up = Number(j && j.sentiment_votes_up_percentage);
      return Number.isFinite(up) ? up : null;
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

// Bulk-reads the ENTIRE asset_daily_bars archive once (a full-table scan,
// but cheap even at real scale relative to D1's 5M-rows-read/day cap — see
// the plan's own sizing) and tests every ordered pair in memory — the
// expensive part of O(n^2) pairs is per-pair D1 round-trips, which loading
// once avoids entirely; the arithmetic itself is trivial even at a few
// hundred symbols (tens of thousands of ordered pairs × a handful of lags
// each, all plain JS after the one read).
export async function computeLeadLag(env) {
  const rows = await d1(env, 'SELECT symbol, date, close FROM asset_daily_bars ORDER BY symbol, date');
  const barsBySymbol = {};
  for (const r of rows) (barsBySymbol[r.symbol] ??= []).push(r);

  const returnsBySymbol = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    if (bars.length < 2) continue;
    const rets = {};
    for (let i = 1; i < bars.length; i++) {
      if (bars[i - 1].close) rets[bars[i].date] = (bars[i].close / bars[i - 1].close - 1) * 100;
    }
    returnsBySymbol[symbol] = rets;
  }

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
