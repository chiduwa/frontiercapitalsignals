// Executes the ONE flush setup with a defensible payoff ratio:
// an up-spike whose open interest FELL through it — shorts covering — which
// the study measures as retracing 106% of the move (docs/FLUSH_EVIDENCE.md).
//
// It deliberately does NOT trade the dip/BUY case. That case has a 0.60
// reward:risk and depends entirely on a 15% stop surviving; the operator chose
// the stronger subset and this file enforces that choice in code rather than
// in configuration.
//
//   traded    spike + OI FELL  -> SELL. R:R 1.22, 106% median retrace, n=41.
//   refused   spike + OI ROSE  -> new longs, +10.82% at 12h. Fading is fighting.
//   refused   dip   + anything -> not this executor's job.
//
// FIRST-EXECUTION WARNING, stated here because it is load-bearing: as of
// 2026-09-12 the order-placement path in this repo had NEVER executed against
// any endpoint (trading-bot/README.md). The first order this file places is
// also the first proof that placement works at all. Every gate below assumes
// that, and none of them should be loosened until a fill has been observed
// end to end.
import {
  placeLimitOrderReconciled, placeProtectiveOrder, getOpenAlgoOrders,
  getPositionAmount, getOpenOrders, cancelOrder
} from './binance.mjs';
import { planEntry } from '../../signals-worker/scripts/flush-entry.mjs';
import { loadGates, isTradeableSetup, quantityFor, FLUSH_EXEC_VERSION } from './flush-gates.mjs';
import { d1 } from '../../signals-worker/scripts/d1-client.mjs';

// True when this executor has already placed protection for a symbol at some
// point. Used to decide whether a MISSING protective order means "never placed"
// or "the operator cancelled it".
//
// The distinction matters and has no safe default: re-placing a stop the owner
// deliberately removed overrides a human decision with a stale one. Instructed
// explicitly — if the operator cancels the stop or take-profit, nothing
// re-creates it, and the position is theirs to manage.
export async function protectionAlreadyPlaced(env, symbol) {
  const rows = await d1(env,
    `SELECT id FROM flush_event
     WHERE symbol = ? AND notes LIKE '%"protected":true%' LIMIT 1`, [symbol]);
  return rows.length > 0;
}

export async function findCandidates(env, { limit = 5 } = {}) {
  return d1(env,
    `SELECT id, symbol, direction, classification, ref_price, extreme_price, move_pct,
            oi_change_pct, first_ts, notes
     FROM flush_event
     WHERE direction = 'up' AND classification = 'liquidation'
       AND (notes IS NULL OR notes NOT LIKE '%"acted"%')
       AND first_ts >= ?
     ORDER BY first_ts DESC LIMIT ?`,
    [Date.now() - 30 * 60000, limit]);
}

async function markActed(env, id, payload) {
  await d1(env, 'UPDATE flush_event SET notes = ? WHERE id = ?',
    [JSON.stringify({ acted: true, version: FLUSH_EXEC_VERSION, ...payload }), id]);
}

export async function runOnce(env, { log = console.log, dryRun = false } = {}) {
  const gates = loadGates();
  if (!gates.enabled) {
    log('flush-exec: disabled (FLUSH_EXEC_ENABLED is not "true") — nothing done');
    return { acted: 0, reason: 'disabled' };
  }
  if (!gates.notional) {
    log('flush-exec: FLUSH_EXEC_NOTIONAL_USD is unset. Position size has no safe default; refusing.');
    return { acted: 0, reason: 'no notional configured' };
  }

  const candidates = await findCandidates(env);
  if (!candidates.length) { log('flush-exec: no fresh short-covering spikes'); return { acted: 0 }; }

  let acted = 0;
  for (const ev of candidates) {
    if (acted >= gates.maxConcurrent) break;
    const setup = isTradeableSetup(ev);
    if (!setup.ok) { log(`  skip ${ev.symbol}: ${setup.reason}`); continue; }

    const plan = planEntry({
      direction: ev.direction, classification: ev.classification,
      refPrice: ev.ref_price, extremePrice: ev.extreme_price,
      movePct: ev.move_pct, oiChangePct: ev.oi_change_pct, symbol: ev.symbol
    });
    if (!plan.ok) { log(`  skip ${ev.symbol}: ${plan.reason}`); continue; }
    if (plan.side !== 'SELL') { log(`  skip ${ev.symbol}: planner returned ${plan.side}, this executor only sells spikes`); continue; }

    const venue = `${ev.symbol}USDT`;

    // Never add to, or fight, an existing position — including one a human or
    // the main bot opened. The account is shared.
    let existing = null;
    try { existing = await getPositionAmount(venue); }
    catch (e) { log(`  skip ${ev.symbol}: could not read position (${e.message})`); continue; }
    if (existing !== 0 && existing != null) { log(`  skip ${ev.symbol}: position already open (${existing})`); continue; }

    const open = await getOpenOrders(venue).catch(() => []);
    if (open && open.length) { log(`  skip ${ev.symbol}: ${open.length} order(s) already resting`); continue; }

    // If this executor has protected this symbol before and there is no
    // protective order now, the operator cancelled it. Respect that: do not
    // open a fresh position on a symbol whose protection was deliberately
    // removed, because the new entry would re-create the very stop that was
    // just cancelled.
    if (await protectionAlreadyPlaced(env, ev.symbol)) {
      const algosNow = await getOpenAlgoOrders(venue).catch(() => []);
      if (!algosNow || !algosNow.length) {
        log(`  skip ${ev.symbol}: protection was placed before and is gone — treating as a manual override, not re-arming`);
        continue;
      }
    }

    const qty = quantityFor(gates.notional, plan.entryPrice, null);
    if (!qty) { log(`  skip ${ev.symbol}: could not size`); continue; }

    const clientOrderId = `fx-${ev.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
    const goodTillDate = Date.now() + gates.ttlMin * 60000;

    log(`  PLAN ${ev.symbol} SELL ${qty} @ ${plan.entryPrice.toPrecision(6)} `
      + `stop ${plan.stopPrice.toPrecision(6)} target ${plan.targetPrice.toPrecision(6)} `
      + `${gates.leverage}x notional $${gates.notional} ttl ${gates.ttlMin}m`);

    if (dryRun) { log('  (dry run — no order submitted)'); continue; }

    try {
      const order = await placeLimitOrderReconciled(venue, 'SELL', qty, plan.entryPrice,
        { clientOrderId, goodTillDate });
      log(`  SUBMITTED ${ev.symbol} orderId=${order.orderId ?? '?'} status=${order.status ?? '?'}`);

      // Protection is placed immediately, not after a fill is confirmed: a
      // reduceOnly stop against a not-yet-existing position is rejected
      // harmlessly, whereas an unprotected fill is the failure that matters.
      //
      // It is placed EXACTLY ONCE. If the operator later cancels it by hand,
      // that cancellation is a decision and this code does not overrule it —
      // see protectionAlreadyPlaced(). An automated system that silently
      // re-places an order a human just removed is fighting its owner.
      try {
        const algos = await getOpenAlgoOrders(venue).catch(() => []);
        if (!algos || !algos.length) {
          await placeProtectiveOrder(venue, 'BUY', 'STOP_MARKET', plan.stopPrice, qty, `${clientOrderId}s`);
          log(`  PROTECTED ${ev.symbol} stop ${plan.stopPrice.toPrecision(6)}`);
        }
      } catch (e) {
        // An entry that cannot be protected is cancelled rather than left naked.
        log(`  PROTECTION FAILED for ${ev.symbol} (${e.message}) — cancelling the entry`);
        await cancelOrder({ symbol: venue, clientOrderId }).catch((c) => log(`  cancel failed: ${c.message}`));
        await markActed(env, ev.id, { outcome: 'cancelled-unprotectable', error: String(e.message).slice(0, 120) });
        continue;
      }

      await markActed(env, ev.id, {
        outcome: 'submitted', side: 'SELL', qty, entry: plan.entryPrice,
        stop: plan.stopPrice, target: plan.targetPrice, clientOrderId,
        protected: true
      });
      acted++;
    } catch (e) {
      log(`  ORDER FAILED ${ev.symbol}: ${e.message}`);
      await markActed(env, ev.id, { outcome: 'failed', error: String(e.message).slice(0, 160) });
    }
  }
  return { acted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID
  };
  runOnce(env, { dryRun: process.argv.includes('--dry') })
    .then((r) => console.log(`flush-exec done: ${r.acted} acted`))
    .catch((e) => { console.error(e); process.exit(1); });
}
