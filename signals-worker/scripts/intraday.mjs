// Day-trading intraday pipeline — separate from the hourly-ish confluence
// engine (worker.js's buildPayload) on purpose. asset_price_log (the
// engine's only price history) is written once per buildPayload run, and
// the real achieved gap between runs is 20-90+ minutes even on a 5-minute
// cron (confirmed live via GitHub Actions run timestamps) — too sparse for
// minutes-to-hours day-trading calls. This module owns the pieces that need
// genuinely higher-frequency sampling: watchlist selection, tick writes,
// and (later phases) signal casting, maturity scoring, and paper-trade
// bookkeeping. Shared by build-signals.mjs (watchlist selection, piggybacks
// on data it fetches anyway) and scripts/intraday-tick.mjs (the dedicated
// per-tick job, scripts/schema.sql's intraday_* tables).
import { d1, chunk } from './d1-client.mjs';

// Top N by open interest, not by market cap — cap and perp-market depth
// diverge (a large mostly-spot-held cap can have a thin perp; a mid-cap can
// have deep perp OI), and open interest is the more honest proxy for
// "actually has a liquid 30x market" than market-cap rank. 25 is a
// deliberately small, curated list — the point is coverage of what a real
// leveraged day trader would actually watch, not the full ~70-coin universe
// this repo tracks for the swing-oriented engine.
export const CRYPTO_WATCHLIST_SIZE = 25;
// Equities are the explicitly secondary case here ("mostly crypto") — a
// fixed list, not a computed ranking: the two most liquid broad-market
// ETFs plus the mega-cap names already at the front of STOCK_WATCHLIST
// (AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA, AVGO), the ones with the
// deepest realistic intraday liquidity among what's already tracked.
const EQUITY_INDEX_WATCHLIST = ['SPY', 'QQQ'];
const EQUITY_MEGACAP_COUNT = 8;

// Pure: given the qualifying crypto universe (same mcap/volume/blocklist
// filter build-signals.mjs already applies elsewhere, each entry carrying
// at least {symbol, id} — id is the CoinGecko id, needed later to fetch a
// live price via coingeckoSimplePrice, which takes ids not tickers) and a
// funding map (getFundingMap()'s shape: {[symbol]: {openInterest, ...}}),
// returns the curated day-trading watchlist. stockWatchlist is passed in
// (rather than importing STOCK_WATCHLIST directly) so this stays a plain,
// synchronous, easily unit-testable function.
export function selectIntradayWatchlist(qualifyingCrypto, funding, stockWatchlist) {
  const crypto = qualifyingCrypto
    .filter((c) => funding && funding[c.symbol])
    .map((c) => ({ symbol: c.symbol, id: c.id, assetClass: 'crypto', openInterest: funding[c.symbol].openInterest || 0 }))
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, CRYPTO_WATCHLIST_SIZE)
    .map(({ symbol, id, assetClass }) => ({ symbol, id, assetClass }));
  const equitySymbols = [...EQUITY_INDEX_WATCHLIST, ...(stockWatchlist || []).slice(0, EQUITY_MEGACAP_COUNT)];
  const equities = equitySymbols.map((symbol) => ({ symbol, assetClass: 'stock' }));
  return [...crypto, ...equities];
}

// INSERT OR IGNORE: a symbol re-ticked at the same instant (shouldn't
// happen, but a retried job run is a real possibility) just no-ops rather
// than erroring. 20 rows x 4 cols = 80 params, safely under D1's confirmed
// 100-bound-param ceiling.
export async function upsertIntradayTicks(env, rows) {
  if (!rows.length) return 0;
  let written = 0;
  for (const batch of chunk(rows, 20)) {
    const placeholders = batch.map(() => '(?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [r.tick_at, r.asset_class, r.symbol, r.price]);
    await d1(env, `INSERT OR IGNORE INTO intraday_price_ticks (tick_at, asset_class, symbol, price) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// A single cutoff, not the dual retention/hard-cap pattern technique_votes
// uses — that pattern exists because a vote row can't be deleted until
// it's BOTH old AND matured (evaluated_24/evaluated_168), two independent
// conditions. A raw price tick has no maturity concept of its own; nothing
// in this pipeline depends on a tick surviving past its own age. 30h gives
// a 6h buffer past the 24h rolling day-high/low window the "peaked for the
// day" read (Phase 2) needs.
const TICK_RETENTION_HOURS = 30;
export async function pruneIntradayTicks(env, nowMs = Date.now(), retentionHours = TICK_RETENTION_HOURS) {
  const cutoff = new Date(nowMs - retentionHours * 3600 * 1000).toISOString();
  await d1(env, 'DELETE FROM intraday_price_ticks WHERE tick_at < ?', [cutoff]);
}
