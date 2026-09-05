// The bot's own track record (trading_bot_shadow_trades, migration 0015).
//
// Records every entry the bot would have taken — including the ones the
// engine had not authorized — and resolves them against real subsequent
// prices. Nothing here ever places an order, and nothing here feeds a sizing
// or authorization decision: it is measurement, deliberately downstream of
// every gate, in the same spirit as the engine's own shadow research lane.
//
// Why it exists: v7 withholds every direction until independent evidence
// rebuilds. Without this, the cold start would end with evidence about the
// ENGINE and none at all about the bot's own selection quality.
import { d1 } from '../../signals-worker/scripts/d1-client.mjs';
import { config } from './config.mjs';
import { timeExitAfterMs } from './risk.mjs';

const env = {
  CLOUDFLARE_API_TOKEN: config.cloudflareApiToken,
  CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId,
  FCS_D1_DATABASE_ID: config.d1DatabaseId
};

export async function loadOpenShadowTrades() {
  return d1(env, `
    SELECT id, opened_at, mode, source, symbol, signal_symbol, side, entry_price,
           stop_price, target_price, leverage, horizon_hours, time_exit_after_ms,
           running_high, running_low
    FROM trading_bot_shadow_trades
    WHERE resolved_at IS NULL
    ORDER BY opened_at
    LIMIT ?
  `, [config.shadowMaxOpen]);
}

// `mode` is the provenance of this row, never pooled with the others:
// shadow (engine had not authorized), dry (authorized, DRY_RUN on), live.
export async function recordEntry({ mode, candidate, decision, entryPrice, stopPrice, targetPrice, openedAt }) {
  const holding = candidate.holding || null;
  await d1(env, `
    INSERT INTO trading_bot_shadow_trades
      (opened_at, mode, source, symbol, signal_symbol, side, entry_price, stop_price,
       target_price, position_pct, leverage, extreme_boost, withheld_reason,
       horizon_hours, time_exit_after_ms, edge, holding_n, holding_mfe_pct,
       holding_mae_pct, holding_hours_to_peak)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `, [
    openedAt, mode, candidate.source, candidate.symbol, candidate.signalSymbol,
    decision.side, entryPrice, stopPrice ?? null, targetPrice ?? null,
    decision.positionPct, decision.leverage, decision.extremeBoost ? 1 : 0,
    mode === 'shadow' ? (decision.reason || null) : null,
    candidate.horizonHours ?? null,
    timeExitAfterMs(holding, candidate.horizonHours, decision.extremeBoost) ?? null,
    Number.isFinite(candidate.edge) ? candidate.edge : null,
    holding?.n ?? null, holding?.mfePct ?? null,
    holding?.maePct ?? null, holding?.hoursToPeak ?? null
  ]);
}

// Decides whether an open ledger row has finished, given the extremes seen
// since entry. Pure, so the resolution rules are testable without D1 or
// Binance.
//
// Resolution deliberately uses the running high/low rather than the latest
// mark. A stop that was breached and then recovered between two cycles is a
// closed trade, not an open one — judging on the current price alone would
// silently drop exactly the losers and flatter this record.
//
// KNOWN LIMIT, stated rather than hidden: those extremes are sampled at the
// cycle cadence (~5 minutes), so a spike through a level and back inside one
// gap is invisible here. A real position does not have that problem — its
// stop and target live on the exchange and trigger on any tick. This ledger
// is therefore biased slightly OPTIMISTIC against a live position, and must
// not be read as a like-for-like backtest of one.
//
// When both levels are through, it resolves as the STOP. Which came first is
// unknowable from sampled extremes, so it takes the unflattering reading.
export function resolveShadowTrade(row, markPrice, nowMs) {
  const side = row.side;
  const entry = Number(row.entry_price);
  if (!(entry > 0) || !(markPrice > 0)) return null;
  const stop = Number(row.stop_price);
  const target = Number(row.target_price);

  const high = Math.max(Number(row.running_high) || entry, markPrice);
  const low = Math.min(Number(row.running_low) || entry, markPrice);

  const stopSeen = Number.isFinite(stop) && stop > 0 && (side === 'BUY' ? low <= stop : high >= stop);
  const targetSeen = Number.isFinite(target) && target > 0 && (side === 'BUY' ? high >= target : low <= target);

  if (stopSeen) return { exitPrice: stop, reason: 'stop', returnPct: signedReturnPct(side, entry, stop, row.leverage) };
  if (targetSeen) return { exitPrice: target, reason: 'target', returnPct: signedReturnPct(side, entry, target, row.leverage) };

  const openedMs = Date.parse(row.opened_at);
  if (!Number.isFinite(openedMs)) return null;
  const elapsed = nowMs - openedMs;
  const timeExitAfter = Number(row.time_exit_after_ms);
  const horizonMs = Number.isFinite(Number(row.horizon_hours)) ? Number(row.horizon_hours) * 3600000 : null;

  if (Number.isFinite(timeExitAfter) && timeExitAfter > 0 && elapsed >= timeExitAfter) {
    return { exitPrice: markPrice, reason: 'time', returnPct: signedReturnPct(side, entry, markPrice, row.leverage) };
  }
  if (horizonMs != null && elapsed >= horizonMs) {
    return { exitPrice: markPrice, reason: 'horizon', returnPct: signedReturnPct(side, entry, markPrice, row.leverage) };
  }
  return null;
}

// Carries the extremes forward for a row that is still open, so the next
// cycle judges against everything seen since entry rather than only its own
// snapshot.
export async function updateExtremes(id, markPrice) {
  await d1(env, `
    UPDATE trading_bot_shadow_trades
    SET running_high = MAX(COALESCE(running_high, entry_price), ?),
        running_low  = MIN(COALESCE(running_low, entry_price), ?)
    WHERE id = ? AND resolved_at IS NULL
  `, [markPrice, markPrice, id]);
}

// Signed return in the direction taken, at this position's own leverage,
// GROSS of fees and funding. Gross deliberately: a cost assumption belongs in
// the analysis that reads this table, not baked into the stored observation
// where it could never be revisited.
function signedReturnPct(side, entry, exit, leverage) {
  const raw = (exit / entry - 1) * 100;
  const directional = side === 'BUY' ? raw : -raw;
  return directional * (Number(leverage) || 1);
}

export async function markResolved(id, { exitPrice, reason, returnPct }, resolvedAt) {
  await d1(env, `
    UPDATE trading_bot_shadow_trades
    SET resolved_at = ?, exit_price = ?, exit_reason = ?, return_pct = ?
    WHERE id = ? AND resolved_at IS NULL
  `, [resolvedAt, exitPrice, reason, returnPct, id]);
}

// A compact scoreboard for the cycle log, so the Actions run itself shows
// whether the shadow record is accumulating and how it is doing. Split by
// mode because pooling a shadow entry with an executed one would be exactly
// the kind of provenance blending the engine's audit exists to prevent.
export async function shadowSummary() {
  return d1(env, `
    SELECT mode, source, COUNT(*) AS n,
           SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open_n,
           SUM(CASE WHEN return_pct > 0 THEN 1 ELSE 0 END) AS wins,
           AVG(return_pct) AS avg_return_pct
    FROM trading_bot_shadow_trades
    GROUP BY mode, source
  `);
}
