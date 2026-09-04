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
import { selectNonOverlappingForecasts, insertForecastOutcomes, aggregatePendingForecastOutcomes, pathExcursionStats } from './reliability.mjs';
import { intradaySignal, INTRADAY_DEADBAND_PCT, INTRADAY_TICK_TOLERANCE_MIN, MIN_RELIABILITY_SAMPLES, isReliabilitySignificant } from '../worker.js';

// No user-facing leverage/liquidation/position-size numbers ever leave
// this module — see scripts/intraday-tick.mjs's assembled display object
// (Phase 4) and the approved plan's design note on why: this is a
// self-experiment/transparency mechanism, not individualized trading
// advice. These constants are internal bookkeeping only.
const PAPER_TRADE_MARGIN_USD = 100;
// Matches the shortest logged horizon — most representative of the
// user's actual day-trading cadence, and the same horizon
// castIntradaySignals already writes a row for, so no new signal-log
// shape is needed to trigger an entry.
const PAPER_TRADE_HOLD_MINUTES = 15;
// 4x for stocks, not a blind reuse of the crypto figure: 30x isn't a real
// retail equities-margin number (this codebase's own valuation/earnings
// techniques already draw this same crypto/equity distinction elsewhere),
// so bookkeeping "as if" 30x on a stock would be dishonest, not just
// imprecise.
const PAPER_TRADE_LEVERAGE = { crypto: 30, stock: 4 };
// Adverse move (in the LOSING direction, leverage-independent — this is
// the RAW price move) that simulates a liquidation. An approximation of
// 1/leverage minus a maintenance-margin haircut, not a specific
// exchange's exact formula (real liquidation price depends on margin
// mode, funding, and venue) — documented as an approximation because it
// is one.
const PAPER_TRADE_LIQUIDATION_PCT = { crypto: 2.8, stock: 20 };

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

// Exact-horizon labels are one-sided: a tick before the target would shorten a
// 15-minute forecast into a 5- or 10-minute outcome. Select the first valid tick
// at or after target, within the declared scheduler tolerance.
export function firstTickAtOrAfter(ticks, targetMs, toleranceMs) {
  if (!Array.isArray(ticks) || !Number.isFinite(targetMs) || !Number.isFinite(toleranceMs) || toleranceMs < 0) return null;
  let best = null;
  for (const tick of ticks) {
    const at = Date.parse(tick && tick.tick_at);
    const price = Number(tick && tick.price);
    if (!Number.isFinite(at) || !Number.isFinite(price) || price <= 0) continue;
    if (at < targetMs || at > targetMs + toleranceMs) continue;
    if (!best || at < best.at) best = { ...tick, price, at };
  }
  return best;
}

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

    const candidates = [];
    const evaluatedIds = [];
    for (const r of due) {
      const targetMs = new Date(r.tick_at).getTime() + horizonMinutes * 60 * 1000;
      const match = firstTickAtOrAfter(ticksBySymbol[r.symbol] || [], targetMs, toleranceMs);
      if (!match) continue; // no tick landed near the target instant (yet, or a real pipeline gap) — leave pending, retention prune cleans it up eventually

      const pct = ((match.price / r.entry_price) - 1) * 100;
      const deadband = INTRADAY_DEADBAND_PCT[r.asset_class] ?? INTRADAY_DEADBAND_PCT.crypto;
      const actualDir = pct > deadband ? 1 : pct < -deadband ? -1 : 0;
      const path = pathExcursionStats(ticksBySymbol[r.symbol] || [], r.entry_price, r.tick_at, match.tick_at);
      candidates.push({
        run_at: r.tick_at,
        asset_class: r.asset_class,
        symbol: r.symbol,
        horizon_minutes: horizonMinutes,
        series_kind: 'intraday',
        series_key: 'intraday-v1',
        dir: r.dir,
        actual_dir: actualDir,
        correct: r.dir === actualDir ? 1 : 0,
        return_pct: pct,
        target_at: new Date(targetMs).toISOString(),
        observed_at: match.tick_at,
        entry_price: r.entry_price,
        exit_price: match.price,
        ...(path || {}),
        model_version: 'intraday-v1',
        label_version: `intraday-deadband-${deadband}pct-v1`,
        evaluated_at: nowIso
      });
      evaluatedIds.push(r.id);
    }

    const priorRows = await d1(env, `
      SELECT asset_class, symbol, horizon_minutes, series_kind, series_key, MAX(run_at) AS last_run_at
      FROM forecast_outcomes
      WHERE series_kind = 'intraday' AND horizon_minutes = ?
      GROUP BY asset_class, symbol, horizon_minutes, series_kind, series_key
    `, [horizonMinutes]);
    const prior = {};
    for (const row of priorRows) {
      prior[`${row.asset_class}|${row.symbol}|${row.horizon_minutes}|${row.series_kind}|${row.series_key}`] = row.last_run_at;
    }
    const partition = selectNonOverlappingForecasts(candidates, horizonMinutes, prior);
    if (partition.accepted.length) await insertForecastOutcomes(env, partition.accepted);
    evaluatedCount += partition.accepted.length;

    // Every row with a valid target tick is complete, even when its forward
    // window overlaps an accepted trial and is intentionally excluded from n.
    // The append-only ledger is written first, so retries remain idempotent.
    for (const batch of chunk(evaluatedIds, 50)) {
      const idPlaceholders = batch.map(() => '?').join(',');
      await d1(env, `UPDATE intraday_signal_log SET evaluated = 1 WHERE id IN (${idPlaceholders})`, batch);
    }
    await aggregatePendingForecastOutcomes(env, nowIso);
  }

  const retentionCutoff = new Date(now - SIGNAL_LOG_RETENTION_HOURS * 3600 * 1000).toISOString();
  await d1(env, 'DELETE FROM intraday_signal_log WHERE tick_at < ?', [retentionCutoff]);

  return evaluatedCount;
}

// ------------------------- PAPER-TRADING SIMULATOR --------------------------
// The "run background experiments off the system's own signals, track
// outcomes" mechanism — every trade is tied back to the intraday_signal_log
// row that triggered it (signal_log_id), so this feeds the same underlying
// track record the reliability loop above already builds, not a separate
// disconnected feature.

// Opens a simulated $100-margin position for every freshly-cast 15-minute
// directional call that doesn't already have an open trade on that symbol
// — one open position per symbol at a time, so a fresh signal while one's
// already running is ignored rather than queued or averaged in.
export async function openPaperTrades(env, tickAt) {
  const candidates = await d1(env, 'SELECT id, asset_class, symbol, dir, entry_price FROM intraday_signal_log WHERE tick_at = ? AND horizon_minutes = ?', [tickAt, PAPER_TRADE_HOLD_MINUTES]);
  if (!candidates.length) return 0;

  const openRows = await d1(env, "SELECT DISTINCT symbol FROM paper_trades WHERE status = 'open'");
  const openSymbols = new Set(openRows.map((r) => r.symbol));

  const rows = candidates
    .filter((c) => !openSymbols.has(c.symbol))
    .map((c) => ({
      signal_log_id: c.id, asset_class: c.asset_class, symbol: c.symbol, dir: c.dir,
      horizon_minutes: PAPER_TRADE_HOLD_MINUTES, entry_at: tickAt, entry_price: c.entry_price
    }));
  if (!rows.length) return 0;

  let written = 0;
  // 8 cols x 12 rows = 96 params, under D1's 100 ceiling.
  for (const batch of chunk(rows, 12)) {
    const placeholders = batch.map(() => "(?,?,?,?,?,?,?,'open')").join(',');
    const params = batch.flatMap((r) => [r.signal_log_id, r.asset_class, r.symbol, r.dir, r.horizon_minutes, r.entry_at, r.entry_price]);
    await d1(env, `INSERT INTO paper_trades (signal_log_id, asset_class, symbol, dir, horizon_minutes, entry_at, entry_price, status) VALUES ${placeholders}`, params);
    written += batch.length;
  }
  return written;
}

// Closes every open trade whose horizon has elapsed OR whose adverse move
// has crossed the simulated liquidation threshold, whichever comes first
// — checked against ticksBySymbol's freshest price for that symbol this
// pass (a symbol with no fresh tick this particular run just gets
// rechecked next tick, not force-closed on stale data).
export async function closePaperTrades(env, ticksBySymbol, nowIso) {
  const open = await d1(env, "SELECT id, asset_class, symbol, dir, horizon_minutes, entry_at, entry_price FROM paper_trades WHERE status = 'open'");
  if (!open.length) return 0;

  const now = new Date(nowIso).getTime();
  const today = nowIso.slice(0, 10);
  const statsDeltas = {}; // "assetClass|today" -> {wins, losses, total, sumReturnPct}
  let closed = 0;

  for (const t of open) {
    const symTicks = (ticksBySymbol[t.symbol] && ticksBySymbol[t.symbol].ticks) || [];
    if (!symTicks.length) continue; // no fresh price this pass — recheck next tick
    const current = symTicks.reduce((a, b) => (new Date(b.tick_at).getTime() > new Date(a.tick_at).getTime() ? b : a));

    const rawReturnPct = ((current.price / t.entry_price) - 1) * t.dir * 100; // positive = favorable in the called direction
    const liqPct = PAPER_TRADE_LIQUIDATION_PCT[t.asset_class] ?? PAPER_TRADE_LIQUIDATION_PCT.crypto;
    const leverage = PAPER_TRADE_LEVERAGE[t.asset_class] ?? PAPER_TRADE_LEVERAGE.crypto;
    const liquidated = rawReturnPct <= -liqPct;
    const horizonElapsed = now >= new Date(t.entry_at).getTime() + t.horizon_minutes * 60 * 1000;
    if (!liquidated && !horizonElapsed) continue;

    const leveragedReturnPct = liquidated ? -100 : Math.max(-100, rawReturnPct * leverage);
    const pnlUsd = (leveragedReturnPct / 100) * PAPER_TRADE_MARGIN_USD;

    await d1(env, `
      UPDATE paper_trades SET exit_at = ?, exit_price = ?, status = 'closed', closed_reason = ?, leveraged_return_pct = ?, pnl_usd = ?
      WHERE id = ?
    `, [nowIso, current.price, liquidated ? 'liquidated' : 'horizon_elapsed', leveragedReturnPct, pnlUsd, t.id]);
    closed++;

    const key = `${t.asset_class}|${today}`;
    if (!statsDeltas[key]) statsDeltas[key] = { assetClass: t.asset_class, wins: 0, losses: 0, total: 0, sumReturnPct: 0 };
    statsDeltas[key].total += 1;
    statsDeltas[key].sumReturnPct += leveragedReturnPct;
    if (leveragedReturnPct > 0) statsDeltas[key].wins += 1; else statsDeltas[key].losses += 1;
  }

  for (const d of Object.values(statsDeltas)) {
    await d1(env, `
      INSERT INTO paper_trade_stats (asset_class, bucket, wins, losses, total, sum_return_pct, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (asset_class, bucket) DO UPDATE SET
        wins = paper_trade_stats.wins + excluded.wins,
        losses = paper_trade_stats.losses + excluded.losses,
        total = paper_trade_stats.total + excluded.total,
        sum_return_pct = paper_trade_stats.sum_return_pct + excluded.sum_return_pct,
        updated_at = excluded.updated_at
    `, [d.assetClass, today, d.wins, d.losses, d.total, d.sumReturnPct, nowIso]);
  }

  return closed;
}

// Closed trades don't need to stick around once rolled into
// paper_trade_stats — that table already holds the permanent aggregate.
const PAPER_TRADE_RETENTION_DAYS = 90;
export async function pruneClosedPaperTrades(env, nowMs = Date.now(), retentionDays = PAPER_TRADE_RETENTION_DAYS) {
  const cutoff = new Date(nowMs - retentionDays * 24 * 3600 * 1000).toISOString();
  await d1(env, "DELETE FROM paper_trades WHERE status = 'closed' AND exit_at < ?", [cutoff]);
}

// ------------------------- DISPLAY PAYLOAD ASSEMBLY --------------------------
const HORIZON_LABELS = { 15: '15m', 30: '30m', 60: '1h' };

// Research snapshot written by a manually dispatched tick job. The public
// /api/intraday route is disabled because this model did not demonstrate a
// usable edge. Keep measurements and aggregate track record, but never write a
// directional call or methodology fallback horizon into the compatibility KV.
export async function buildIntradayDisplayPayload(env, watchlist, ticksBySymbol, nowIso) {
  const symbols = watchlist.map((w) => w.symbol);
  if (!symbols.length) return { generated_at: nowIso, watchlist: [], trackRecord: {} };

  const placeholders = symbols.map(() => '?').join(',');
  const relRows = await d1(env, `SELECT symbol, horizon_minutes, correct, total, accuracy FROM intraday_reliability WHERE symbol IN (${placeholders})`, symbols);
  const relBySymbol = {};
  for (const r of relRows) (relBySymbol[r.symbol] ??= {})[r.horizon_minutes] = r;

  const statsRows = await d1(env, 'SELECT asset_class, SUM(wins) AS wins, SUM(losses) AS losses, SUM(total) AS total, SUM(sum_return_pct) AS sum_return_pct FROM paper_trade_stats GROUP BY asset_class');
  const trackRecord = {};
  for (const r of statsRows) {
    trackRecord[r.asset_class] = {
      wins: r.wins, losses: r.losses, total: r.total,
      winRate: r.total ? r.wins / r.total : null,
      avgReturnPct: r.total ? r.sum_return_pct / r.total : null
    };
  }

  const displayList = [];
  for (const w of watchlist) {
    const entry = ticksBySymbol[w.symbol];
    const ticks = entry ? entry.ticks : [];
    if (!ticks.length) continue; // never ticked yet (a symbol just added to the watchlist)
    const current = ticks.reduce((a, b) => (new Date(b.tick_at).getTime() > new Date(a.tick_at).getTime() ? b : a));
    let measured = null;
    for (const h of INTRADAY_HORIZONS_MIN) {
      const rec = relBySymbol[w.symbol] && relBySymbol[w.symbol][h];
      if (rec && rec.total >= MIN_RELIABILITY_SAMPLES && isReliabilitySignificant(rec.correct, rec.total)) {
        measured = { horizonMinutes: h, horizonLabel: HORIZON_LABELS[h] || `${h}m`, accuracy: rec.accuracy, samples: rec.total };
        break;
      }
    }

    displayList.push({
      symbol: w.symbol, assetClass: w.assetClass, price: current.price,
      status: 'research-only-not-published', measuredReliability: measured
    });
  }

  return { generated_at: nowIso, watchlist: displayList, trackRecord };
}
