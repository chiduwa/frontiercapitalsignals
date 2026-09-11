import { validExitPolicy, managedExitReason } from './trade-policy.mjs';
import { positionOrigin, positionQuantitiesMatch } from './positions.mjs';
import { marketOrderMatches, isTerminalMarketOrder, makeClientOrderId } from './binance.mjs';

// IO is injected: replay tests exercise identical execution/recovery logic.
// Only exact bot fills are managed; an unresolved intent stops this pass.
export async function managePolicyExits(state, io, { nowMs = Date.now(), reversals = [] } = {}) {
  for (const [symbol, record] of Object.entries(state.openOrders || {})) {
    if (!validExitPolicy(record.roiPolicy) || record.entryOrderPending
        || record.ownershipConflict || record.outcomePending) continue;
    let amount = await io.amount(symbol);
    let pending = record.managedExit;
    const settle = async order => {
      const closingSide = record.side === 'BUY' ? 'SELL' : 'BUY';
      if (!marketOrderMatches(order, { symbol, side: closingSide, quantity: pending.quantity,
        clientOrderId: pending.clientOrderId, reduceOnly: true })) {
        throw new Error(`${symbol}: managed exit identity mismatch; no replacement`);
      }
      if (!isTerminalMarketOrder(order)) return false;
      amount = await io.amount(symbol);
      const filled = Number(order.executedQty);
      const expected = pending.beforeAmount + (closingSide === 'BUY' ? filled : -filled);
      if (!Number.isFinite(filled) || filled < 0 || filled > pending.quantity
          || !positionQuantitiesMatch(expected, amount)) {
        // A concurrent full stop/TP can also produce flat. Do not assume it:
        // preserve the evidence and let exact outcome reconstruction decide.
        if (amount !== 0) {
          record.ownershipVerified = false;
          record.ownershipConflict = true;
        }
        record.managedExit = null;
        await io.save(state);
        io.log('managed_exit_quantity_conflict', { symbol, expected, amount });
        return false;
      }
      record.entryOriginalQty ??= record.entryExecutedQty;
      record.entryExecutedQty = Math.abs(amount);
      if (pending.reason === 'policy-first-profit') {
        record.firstProfitFilledQty = Number(record.firstProfitFilledQty || 0) + filled;
        record.firstProfitComplete = record.firstProfitFilledQty + 1e-12 >= pending.stageTargetQty;
      }
      if (amount === 0) record.exitReason = pending.reason;
      record.managedExit = null;
      await io.save(state);
      io.log('managed_exit_settled', { symbol, reason: pending.reason, filled,
        remaining: Math.abs(amount), orderId: order.orderId });
      return true;
    };
    if (pending) {
      const order = await io.find(symbol, pending.clientOrderId);
      // An absent/ambiguous order is never permission to send another close.
      // Keep the original exchange-side stop and retry the exact ID next pass.
      if (!order || !await settle(order)) continue;
      pending = null;
      // One submission per symbol per pass; no partial-fill churn loop.
      continue;
    }
    if (!amount || positionOrigin(symbol, state, amount > 0 ? 'BUY' : 'SELL', amount) !== 'bot') continue;
    const quote = await io.mark(symbol);
    const reason = managedExitReason({ ...record, symbol }, quote.price, nowMs,
      reversals.find(r => r.symbol === symbol));
    if (!reason) continue;
    const original = Number(record.entryOriginalQty ?? record.entryExecutedQty);
    const stageTargetQty = await io.round(symbol, original * record.roiPolicy.firstFraction);
    let quantity = reason === 'policy-first-profit'
      ? await io.round(symbol, Math.min(Math.abs(amount), stageTargetQty - Number(record.firstProfitFilledQty || 0)))
      : await io.round(symbol, Math.abs(amount));
    if (reason === 'policy-first-profit' && !(quantity > 0)) {
      // A position too small to split is closed at the first target.
      quantity = await io.round(symbol, Math.abs(amount));
    }
    if (!(quantity > 0)) continue;
    if (io.dryRun) {
      io.log('dry_run_managed_exit', { symbol, reason, quantity });
      continue;
    }
    pending = { reason, quantity, beforeAmount: amount,
      stageTargetQty: stageTargetQty > 0 ? stageTargetQty : quantity,
      clientOrderId: makeClientOrderId('rex', symbol, record.entryClientOrderId,
        reason, amount, record.firstProfitFilledQty || 0) };
    record.entryOriginalQty ??= record.entryExecutedQty;
    record.managedExit = pending;
    await io.save(state); // durable write-ahead; failure prevents submission
    const closingSide = record.side === 'BUY' ? 'SELL' : 'BUY';
    let order;
    try {
      order = await io.close(symbol, closingSide, quantity, {
        clientOrderId: pending.clientOrderId, reduceOnly: true,
        onBeforeSubmit: async ({ clientOrderId }) => {
          const fresh = await io.amount(symbol);
          if (!positionQuantitiesMatch(fresh, amount)
              || positionOrigin(symbol, state, record.side, fresh) !== 'bot') {
            throw new Error(`${symbol}: ownership changed before managed exit`);
          }
          pending.clientOrderId = clientOrderId;
          await io.save(state);
        }
      });
    } catch (error) {
      io.log('managed_exit_submission_unresolved', { symbol, error: error.message });
      // ID was saved before every possible submission, including retries.
      continue;
    }
    await settle(order);
  }
}
