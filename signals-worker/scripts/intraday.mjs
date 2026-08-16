// Day-trading intraday pipeline — separate from the hourly-ish confluence
// engine (worker.js's buildPayload) on purpose. asset_price_log (the
// engine's only price history) is written once per buildPayload run, and
// the real achieved gap between runs is 20-90+ minutes even on a 5-minute
// cron (confirmed live via GitHub Actions run timestamps) — too sparse for
// minutes-to-hours day-trading calls. This module owns the pieces that need
// genuinely higher-frequency sampling: watchlist selection, tick writes,
// signal casting, maturity scoring, and (Phase 3) paper-trade bookkeeping.
// Shared by build-signals.mjs (watchlist selection, piggybacks on data it
// fetches anyway) and scripts/intraday-tick.mjs (the dedicated per-tick
// job — casts signals and evaluates maturity every tick, since both are
// cheap D1-only operations once ticks already exist).
import { d1, chunk } from './d1-client.mjs';
import { intradaySignal, nearestTick, INTRADAY_DEADBAND_PCT, INTRADAY_TICK_TOLERANCE_MIN } from '../worker.js';

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

// ------------------------- SIGNAL CASTING + MATURITY ------------------------

// Which forward horizons a single cast signal gets logged against — the
// same "compute once, log at several horizons" shape range_log already
// uses (see schema.sql's intraday_signal_log comment). Also doubles as the
// lookback windows intradaySignal (worker.js) uses to cast the call in the
// first place (15/60 only there) — a momentum-continuation assumption,
// not a coincidence: a call betting the recent trend continues is scored
// against exactly the timeframes it claims to anticipate.
export const INTRADAY_HORIZONS_MIN = [15, 30, 60];
// 24h day-window (for the peaked/bottomed read) plus a 1h buffer so the
// 60-min momentum lookback always has data to compare against even for
// the very first tick of a rolling day.
const SIGNAL_LOOKBACK_HOURS = 25;

// { [symbol]: { assetClass, ticks: [{tick_at, price}] } } for the given
// symbols, covering the last `lookbackHours`. One unchunked IN() query —
// the watchlist is small and bounded (~35 symbols) by design, well under
// D1's param ceiling even unchunked.
export async function loadRecentIntradayTicks(env, symbols, nowMs = Date.now(), lookbackHours = SIGNAL_LOOKBACK_HOURS) {
  if (!symbols.length) return {};
  const cutoff = new Date(nowMs - lookbackHours * 3600 * 1000).toISOString();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await d1(env, `SELECT symbol, asset_class, tick_at, price FROM intraday_price_ticks WHERE symbol IN (${placeholders}) AND tick_at >= ? ORDER BY tick_at ASC`, [...symbols, cutoff]);
  const out = {};
  for (const r of rows) {
    (out[r.symbol] ??= { assetClass: r.asset_class, ticks: [] }).ticks.push({ tick_at: r.tick_at, price: r.price });
  }
  return out;
}

// Casts one signal per symbol (via intradaySignal, worker.js) and logs it
// against every horizon in INTRADAY_HORIZONS_MIN — but only when dir is
// genuinely directional (1 or -1). A neutral/no-confluence read (dir 0) or
// insufficient data (dir null) is never written, same convention
// technique_votes already uses (see worker.js's confluence() docs) — there
// is nothing to score for a call that was never actually made.
export async function castIntradaySignals(env, ticksBySymbol, nowIso) {
  const rows = [];
  for (const [symbol, { assetClass, ticks }] of Object.entries(ticksBySymbol)) {
    const sig = intradaySignal(ticks, nowIso, assetClass);
    if (!sig.dir) continue;
    const current = ticks.reduce((a, b) => (new Date(b.tick_at).getTime() > new Date(a.tick_at).getTime() ? b : a));
    for (const horizonMinutes of INTRADAY_HORIZONS_MIN) {
      rows.push({
        tick_at: nowIso, asset_class: assetClass, symbol, horizon_minutes: horizonMinutes,
        dir: sig.dir, entry_price: current.price, peaked: sig.peaked ? 1 : 0, bottomed: sig.bottomed ? 1 : 0
      });
    }
  }
  if (!rows.length) return 0;
  let written = 0;
  // 8 writable columns x 12 rows = 96 params, under D1's 100 ceiling.
  for (const batch of chunk(rows, 12)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [r.tick_at, r.asset_class, r.symbol, r.horizon_minutes, r.dir, r.entry_price, r.peaked, r.bottomed]);
    await d1(env, `INSERT OR IGNORE INTO intraday_signal_log (tick_at, asset_class, symbol, horizon_minutes, dir, entry_price, peaked, bottomed) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// intraday_signal_log rows that are still unevaluated once their own
// horizon has passed shouldn't accumulate forever if the tick pipeline
// ever has a real gap and a match never lands — matured rows also don't
// need to stick around once scored, since intraday_reliability already
// holds the permanent aggregate. 6h covers the longest horizon (60min)
// plus a generous buffer for tolerance-window matching.
const SIGNAL_LOG_RETENTION_HOURS = 6;

// Mirrors evaluateMatured's (reliability.mjs) cutoff-based maturity
// pattern, but matches each due row against the NEAREST tick to its own
// specific target instant (tick_at + horizon_minutes) rather than a
// shared run_at price — intraday ticks land continuously and irregularly,
// unlike asset_price_log's once-per-build rows, so there's no single
// "this run's price" to reuse across every due row the way evaluateMatured
// does. peaked/bottomed are carried on the row for display only (Phase 4)
// — they deliberately don't get their own reliability rollup here; their
// correctness is already captured by the directional call's own accuracy
// (see the design note in the approved plan for why).
export async function evaluateIntradayMatured(env, nowIso) {
  const now = new Date(nowIso).getTime();
  const toleranceMs = INTRADAY_TICK_TOLERANCE_MIN * 60 * 1000;
  let evaluatedCount = 0;

  for (const horizonMinutes of INTRADAY_HORIZONS_MIN) {
    const cutoff = new Date(now - horizonMinutes * 60 * 1000).toISOString();
    const due = await d1(env, 'SELECT id, tick_at, asset_class, symbol, dir, entry_price FROM intraday_signal_log WHERE horizon_minutes = ? AND evaluated = 0 AND tick_at <= ?', [horizonMinutes, cutoff]);
    if (!due.length) continue;

    const symbols = [...new Set(due.map((r) => r.symbol))];
    const oldestTickAt = due.reduce((min, r) => (r.tick_at < min ? r.tick_at : min), due[0].tick_at);
    const placeholders = symbols.map(() => '?').join(',');
    const tickRows = await d1(env, `SELECT symbol, tick_at, price FROM intraday_price_ticks WHERE symbol IN (${placeholders}) AND tick_at >= ?`, [...symbols, oldestTickAt]);
    const ticksBySymbol = {};
    for (const t of tickRows) (ticksBySymbol[t.symbol] ??= []).push({ tick_at: t.tick_at, price: t.price });

    const deltas = {}; // symbol -> { correct, total, assetClass }
    const evaluatedIds = [];
    for (const r of due) {
      const targetMs = new Date(r.tick_at).getTime() + horizonMinutes * 60 * 1000;
      const match = nearestTick(ticksBySymbol[r.symbol] || [], targetMs, toleranceMs);
      if (!match) continue; // no tick landed near the target instant (yet, or a real pipeline gap) — leave pending, retention prune cleans it up eventually

      const pct = ((match.price / r.entry_price) - 1) * 100;
      const deadband = INTRADAY_DEADBAND_PCT[r.asset_class] ?? INTRADAY_DEADBAND_PCT.crypto;
      const actualDir = pct > deadband ? 1 : pct < -deadband ? -1 : 0;
      if (!deltas[r.symbol]) deltas[r.symbol] = { correct: 0, total: 0, assetClass: r.asset_class };
      deltas[r.symbol].total += 1;
      if (r.dir === actualDir) deltas[r.symbol].correct += 1;
      evaluatedIds.push(r.id);
    }

    for (const [symbol, d] of Object.entries(deltas)) {
      await d1(env, `
        INSERT INTO intraday_reliability (asset_class, symbol, horizon_minutes, correct, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, horizon_minutes) DO UPDATE SET
          correct = intraday_reliability.correct + excluded.correct,
          total = intraday_reliability.total + excluded.total,
          accuracy = CAST(intraday_reliability.correct + excluded.correct AS REAL) / (intraday_reliability.total + excluded.total),
          updated_at = excluded.updated_at
      `, [d.assetClass, symbol, horizonMinutes, d.correct, d.total, d.total ? d.correct / d.total : 0, nowIso]);
      evaluatedCount += d.total;
    }

    for (const batch of chunk(evaluatedIds, 50)) {
      const idPlaceholders = batch.map(() => '?').join(',');
      await d1(env, `UPDATE intraday_signal_log SET evaluated = 1 WHERE id IN (${idPlaceholders})`, batch);
    }
  }

  const retentionCutoff = new Date(now - SIGNAL_LOG_RETENTION_HOURS * 3600 * 1000).toISOString();
  await d1(env, 'DELETE FROM intraday_signal_log WHERE tick_at < ?', [retentionCutoff]);

  return evaluatedCount;
}
