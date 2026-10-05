// Pump-fade shadow lane: detection must reproduce the post-move alert's rule
// (first 10% pump of the UTC day, every horizon agreeing), and settlement must
// never flatter a short. Synthetic bars only, no exchange or D1 access.
import assert from 'node:assert/strict';
import {
  closeDay, closedHourBars, detectPump, settleShort, shortStopPrice, shortFundingPct, netPct,
  summariseLedger, PUMP_FADE_VERSION, STOP_PCT, HOLD_HOURS
} from './src/pump-fade-rules.mjs';
import { loadMode } from './src/pump-fade.mjs';

const HOUR = 3600_000;
const FIVE_MIN = 300_000;
// Last bar opens 14:00 and closes 15:00 UTC on 2026-10-05.
const lastOpen = Date.parse('2026-10-05T14:00:00Z');
const klinesFor = (closes) => closes.map((c, i) => {
  const ts = lastOpen - (closes.length - 1 - i) * HOUR;
  return [ts, String(c), String(c * 1.001), String(c * 0.999), String(c)];
});
const now = lastOpen + HOUR + 60_000;
const flat = (n, v = 100) => Array(n).fill(v);
const detect = (closes) => detectPump(closedHourBars(klinesFor(closes), now));

// The bar that opens 23:00 belongs to the next UTC day: the alert sees it at its close.
assert.equal(closeDay(Date.parse('2026-10-04T23:00:00Z')), '2026-10-05');

// Aligned pump on the latest bar: recorded, no lag.
const pump = detect([...flat(45), 101, 102, 103, 104, 105, 112]);
assert.ok(pump.setup, pump.reason);
assert.equal(pump.setup.lagBars, 0);
assert.equal(pump.setup.signalDay, '2026-10-05');
assert.ok(Math.abs(pump.setup.move6h - 12) < 1e-9);
assert.equal(pump.setup.barCloseTs, lastOpen + HOUR);

// "Now reversing" because only the 1-day change disagrees: not this lane.
const dayOpposite = detect([...flat(27, 130), ...flat(18), 101, 102, 103, 104, 105, 111]);
assert.equal(dayOpposite.setup, null);
assert.match(dayOpposite.reason, /reversing/);

// "Now reversing" because the last hour turned: not this lane either.
const hourTurned = detect([...flat(44), 100, 95, 98, 101, 104, 107, 109, 106]);
assert.equal(hourTurned.setup, null);
assert.match(hourTurned.reason, /reversing/);

// The day's FIRST qualifying hour decides, exactly like the alert's dedup:
// a pump that qualified four bars ago is stale, and a coin that first
// qualified as "now reversing" is not picked up later as a pump.
assert.match(detect([...flat(42), 102, 104, 106, 108, 111, 112, 113, 114, 115]).reason, /4 bars ago/);
// Bar 49 first qualifies with its 1-day change negative; bar 50 would qualify
// as an aligned pump on its own, but the day already had its alert.
const reversingThenAligned = [...flat(26, 130), ...flat(18), 101, 103, 105, 107, 109, 111, 113];
assert.ok(detectPump(closedHourBars(klinesFor(reversingThenAligned), now), { maxLagBars: 0 }).reason.match(/1 bars ago/));
const firstWasReversing = detect(reversingThenAligned);
assert.equal(firstWasReversing.setup, null);
assert.match(firstWasReversing.reason, /reversing/);

// One bar late (a missed hourly run) is still recorded, and says so.
const late = detect([...flat(44), 101, 102, 103, 104, 105, 112, 113]);
assert.ok(late.setup, late.reason);
assert.equal(late.setup.lagBars, 1);

// Under the threshold, or a gap where a horizon's bar should be: nothing.
assert.equal(detect([...flat(45), 101, 102, 103, 104, 105, 109.9]).setup, null);
const gapped = klinesFor([...flat(45), 101, 102, 103, 104, 105, 112]);
gapped.splice(gapped.length - 1 - 24, 1);
assert.match(detectPump(closedHourBars(gapped, now)).reason, /gap/);

// A bar still open at run time is not a bar yet.
assert.equal(closedHourBars(klinesFor(flat(30)), lastOpen + 30 * 60_000).length, 29);

// Settlement on 5-minute bars.
const entryTs = Date.parse('2026-10-05T15:01:30Z');
const fiveMin = (fn, hours = HOLD_HOURS + 1) => Array.from({ length: hours * 12 }, (_, i) => {
  const ts = entryTs - (entryTs % FIVE_MIN) + i * FIVE_MIN;
  return { ts, closeTs: ts + FIVE_MIN, ...fn(i) };
});
const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });

const drift = settleShort({ entryPrice: 100, entryTs, bars: fiveMin(() => bar(99, 99.5, 98.5, 99)) });
assert.equal(drift.exitReason, 'time');
assert.ok(Math.abs(drift.grossPct - 1) < 1e-9);
assert.ok(drift.exitTs >= entryTs + HOLD_HOURS * HOUR && drift.exitTs < entryTs + HOLD_HOURS * HOUR + FIVE_MIN);
assert.ok(Math.abs(drift.maxFavourablePct - 1.5) < 1e-9);

const stopped = settleShort({ entryPrice: 100, entryTs,
  bars: fiveMin((i) => (i === 40 ? bar(104, 116, 103, 105) : bar(100, 101, 99, 100))) });
assert.equal(stopped.exitReason, 'stop');
assert.equal(stopped.exitPrice, shortStopPrice(100, STOP_PCT));
assert.ok(Math.abs(stopped.grossPct + 15) < 1e-9);

// A gap through the stop fills at the open, never at the better stop price.
const gappedStop = settleShort({ entryPrice: 100, entryTs,
  bars: fiveMin((i) => (i === 40 ? bar(120, 121, 119, 120) : bar(100, 101, 99, 100))) });
assert.equal(gappedStop.exitPrice, 120);
assert.ok(Math.abs(gappedStop.grossPct + 20) < 1e-9);

// The entry's own bar counts: a stop touched in its first minutes is a stop.
const entryBarStop = settleShort({ entryPrice: 100, entryTs,
  bars: fiveMin((i) => (i === 0 ? bar(100, 115.5, 99, 101) : bar(100, 101, 99, 100))) });
assert.equal(entryBarStop.exitReason, 'stop');

// Half a hold is not a result: it stays unsettled.
assert.equal(settleShort({ entryPrice: 100, entryTs, bars: fiveMin(() => bar(99, 99.5, 98.5, 99), 12) }), null);

// Funding: a short receives positive rates and pays negative ones.
assert.ok(Math.abs(shortFundingPct(['0.0001', '-0.0003', '0.0001']) + 0.01) < 1e-12);
assert.ok(Math.abs(netPct({ grossPct: 1, fundingPct: -0.05 }) - 0.8) < 1e-12);

// Ledger summary clusters by day: two trades on one day are one observation.
const ledger = summariseLedger([
  { signal_day: 'a', net_pct: 1, exit_reason: 'time', funding_pct: 0 },
  { signal_day: 'a', net_pct: 3, exit_reason: 'time', funding_pct: 0 },
  { signal_day: 'b', net_pct: -1, exit_reason: 'stop', funding_pct: -0.1 },
  { signal_day: 'c', net_pct: 2, exit_reason: 'time', funding_pct: 0 },
  { signal_day: 'd', net_pct: null }
]);
assert.equal(ledger.n, 4);
assert.equal(ledger.days, 3);
assert.equal(ledger.stopRate, 0.25);
assert.ok(Math.abs(ledger.dayClusteredT - (1 / (Math.sqrt(3) / Math.sqrt(3)))) < 1e-9);

// Shadow is the default; there is no live mode to select.
assert.equal(loadMode({}), 'shadow');
assert.equal(loadMode({ PUMP_FADE_MODE: 'off' }), 'off');
assert.equal(loadMode({ PUMP_FADE_MODE: 'live' }), 'refused');
assert.equal(PUMP_FADE_VERSION, 'pump-fade-v1');

console.log('PUMP FADE OK: alert-identical detection, first-hour dedup, conservative settlement, shadow only');
