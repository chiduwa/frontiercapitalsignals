// Fast, protection-only pass for resting LIMIT entries. It deliberately does
// no signal fetch, ranking, sizing, shadow research, or new entry submission.
// The full decision cycle remains on its five-minute timer; this pass closes
// the otherwise-material interval between a LIMIT filling and the next run.
import { config } from './config.mjs';
import { log } from './logger.mjs';
import {
  acquireExecutionLease, releaseExecutionLease, loadState, saveState,
  hasTrackedOpenOrders
} from './state.mjs';
import { getAccount, getPositionRiskMap } from './binance.mjs';
import { positionOrigin } from './positions.mjs';
import {
  reconcilePendingEntries, ensureProtection, cancelTrackedEntry,
  cancelTrackedProtection
} from './index.mjs';

async function runProtectionCycle() {
  const state = await loadState();
  if (!Object.keys(state.openOrders || {}).length) {
    log('protection_cycle_no_bot_state', {});
    return;
  }

  let account = await getAccount();
  if (await reconcilePendingEntries(state)) account = await getAccount();
  const positions = (account.positions || [])
    .filter((position) => Math.abs(Number(position.positionAmt)) > 0);
  const risk = await getPositionRiskMap();
  let changed = false;
  const openSymbols = new Set(positions.map((position) => position.symbol));

  // A stop can close a position between full decision cycles. Remove its
  // exact sibling immediately and spend the old ownership proof so a new
  // personal position cannot inherit the bot's take-profit/stop.
  for (const [symbol, record] of Object.entries(state.openOrders || {})) {
    if (openSymbols.has(symbol) || record.entryOrderPending) continue;
    if (!config.dryRun) await cancelTrackedProtection(symbol, record);
    if (!record.ownershipConflict) {
      record.closedDetectedAt = record.closedDetectedAt || new Date().toISOString();
      record.outcomePending = true;
    }
    record.ownershipVerified = false;
    changed = true;
    log('protection_cycle_flat_tombstone', {
      symbol, closedDetectedAt: record.closedDetectedAt ?? null,
      action: 'exact conditional siblings absent; old ownership proof retired'
    });
  }

  for (const position of positions) {
    const record = state.openOrders[position.symbol];
    if (!record) continue; // provably foreign: never create or cancel its orders
    const amount = Number(position.positionAmt);
    const side = amount > 0 ? 'BUY' : 'SELL';
    const origin = positionOrigin(position.symbol, state, side, amount);
    if (origin === 'bot') {
      let protectedNow;
      try {
        protectedNow = await ensureProtection(position, state, risk);
      } finally {
        // ensureProtection records exact algo identities in memory as each
        // order is observed/created. Preserve those identities even if a
        // later sibling request fails, so the next pass can reconcile or
        // cancel only this bot's orders.
        await saveState(state);
      }
      if (!protectedNow) {
        throw new Error(`${position.symbol} is bot-owned but exact stop protection was not verified`);
      }
      continue;
    }

    record.ownershipVerified = false;
    record.ownershipConflict = true;
    changed = true;
    if (!config.dryRun) {
      await cancelTrackedEntry(
        position.symbol, record, 'protection supervisor observed ownership conflict'
      );
      await cancelTrackedProtection(position.symbol, record);
    }
    log('protection_cycle_ownership_conflict', {
      symbol: position.symbol, observedPositionAmt: amount,
      action: 'exact bot orders canceled; mixed/operator position receives no bot stop'
    });
  }
  if (changed) await saveState(state);
  log('protection_cycle_complete', {
    trackedSymbols: Object.keys(state.openOrders || {}).length,
    openPositions: positions.length
  });
}

async function main() {
  let lease = null;
  try {
    // One cheap D1 probe keeps the idle 15-second timer from doing account
    // reads or lease writes when there is no bot entry to supervise.
    if (!await hasTrackedOpenOrders()) {
      log('protection_cycle_no_bot_state', {});
      return;
    }
    // The same lease name as the decision cycle makes full-state saves
    // mutually exclusive across both services and all hosts.
    lease = await acquireExecutionLease(120);
    if (!lease) {
      log('protection_cycle_skipped_overlap', { lease: 'futures-cycle' });
      return;
    }
    await runProtectionCycle();
  } catch (error) {
    log('critical_protection_cycle_failed', { error: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    if (lease) await releaseExecutionLease(lease).catch((error) => {
      log('warning_protection_lease_release_failed', {
        error: error.message, action: 'the lease expires automatically'
      });
    });
  }
}

main();
