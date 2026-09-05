// D1-backed state. Like the futures bot, this runs as a one-shot script with
// no local disk that survives between firings, so the schedule marker and the
// dry-powder balance live in D1 (spot_bot_* tables, migration 0016).
//
// Actual holdings and balances are always re-read fresh from Binance each
// cycle and never trusted from here — a stale or lost row can therefore
// under- or over-defer a tranche, but it can never cause a phantom buy.
import { d1 } from '../../signals-worker/scripts/d1-client.mjs';
import { config } from './config.mjs';

const env = {
  CLOUDFLARE_API_TOKEN: config.cloudflareApiToken,
  CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId,
  FCS_D1_DATABASE_ID: config.d1DatabaseId
};

export async function loadState() {
  const [row] = await d1(env, 'SELECT last_tranche_at, dry_powder FROM spot_bot_state WHERE id = 1');
  return {
    lastTrancheAt: row?.last_tranche_at ?? null,
    dryPowder: Number(row?.dry_powder ?? 0)
  };
}

export async function saveState(state, nowIso) {
  await d1(env, `
    INSERT INTO spot_bot_state (id, last_tranche_at, dry_powder, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_tranche_at = excluded.last_tranche_at,
      dry_powder = excluded.dry_powder,
      updated_at = excluded.updated_at
  `, [state.lastTrancheAt, Math.max(0, state.dryPowder), nowIso]);
}

export async function recordFill(fill) {
  await d1(env, `
    INSERT INTO spot_bot_fills
      (filled_at, mode, symbol, signal_symbol, sleeve, trigger, trigger_reason,
       quote_spent, price, quantity, order_id, weekly_sigma, typical_drawdown, weeks_history)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    fill.filledAt, fill.mode, fill.symbol, fill.signalSymbol, fill.sleeve,
    fill.trigger, fill.triggerReason, fill.quoteSpent, fill.price,
    fill.quantity ?? null, fill.orderId ?? null,
    fill.weeklySigma ?? null, fill.typicalDrawdown ?? null, fill.weeksHistory ?? null
  ]);
}

// Skips are recorded, not just logged. Conditional DCA's central risk is
// sitting out a rally; without a record of what was declined and why, there is
// no way to judge later whether the waiting actually paid.
export async function recordSkip(skip) {
  await d1(env, `
    INSERT INTO spot_bot_skips (skipped_at, symbol, reason, price, quote_deferred)
    VALUES (?, ?, ?, ?, ?)
  `, [skip.skippedAt, skip.symbol, skip.reason, skip.price ?? null, skip.quoteDeferred ?? null]);
}

// Average cost basis per asset, from this bot's own fills. Reported for
// visibility only — nothing consumes it, because there is no sell path.
export async function costBasis() {
  return d1(env, `
    SELECT symbol, sleeve, COUNT(*) AS fills,
           SUM(quote_spent) AS spent,
           SUM(quantity) AS qty,
           MIN(filled_at) AS first_fill,
           MAX(filled_at) AS last_fill
    FROM spot_bot_fills
    WHERE mode = 'live' AND quantity IS NOT NULL AND quantity > 0
    GROUP BY symbol, sleeve
    ORDER BY spent DESC
  `);
}
