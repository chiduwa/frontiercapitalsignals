// Pure rules for the pump-fade shadow lane, kept apart from the I/O so they can
// be tested without exchange or D1 access (same split as flush-gates.mjs).
//
// The setup is the one the 2026-10-05 replay found, not the one the owner
// asked about. The owner asked to trade the "now reversing" post-move alert;
// replayed over 2,302 of them (258 perp coins, Jul 2024 - Oct 2026) fading it
// lost 0.53% a trade and following it made nothing. The same replay showed the
// ORDINARY pump alert — up 10% or more over 6 hours with the 1h, 3h, 6h and 1d
// changes all positive — falling back afterwards: short for 24 hours with a 15%
// stop, +0.25% a trade after 0.15% costs, t = 4.3 clustered by day, both halves
// of the period and both listing cohorts positive. Funding was not in that
// test, which is the main thing this shadow ledger is here to measure.
// Evidence and method: signals-worker/docs/PUMP_FADE_EVIDENCE.md.
//
// The detection rule mirrors the alert (signals-worker/scripts/notify.mjs,
// checkAndNotifySuddenMoves) exactly, including its dedup: only the FIRST
// hour of a UTC day on which a coin is up 10% over 6 hours counts, and it
// counts only if every rung agrees at that hour. A coin whose first qualifying
// hour was "now reversing" is not picked up later the same day as a pump.

export const PUMP_FADE_VERSION = 'pump-fade-v1';
export const PUMP_THRESHOLD_PCT = 10;
export const PUMP_WINDOW_HOURS = 6;
export const RUNG_HOURS = [1, 3, 6, 24];
export const HOLD_HOURS = 24;
export const STOP_PCT = 15;
// Taker fee both sides (0.05% each at Binance USD-M VIP 0) plus an allowance
// for slippage on a coin that has just moved 10%. The replay used the same.
export const COST_PCT = 0.15;
// A missed hourly run may still record the setup one bar late; the replay
// measured that one-hour-late entry separately (still positive, t = 3.7).
// Anything older is stale and is skipped rather than entered at a worse price.
export const MAX_LAG_BARS = 1;

const HOUR = 3600_000;

// UTC date of a bar's CLOSE, which is when the alert would have seen it.
export function closeDay(openTs) {
  return new Date(openTs + HOUR).toISOString().slice(0, 10);
}

// Binance kline rows -> [{ ts, high, low, close }], closed bars only.
export function closedHourBars(klines, nowMs) {
  const out = [];
  for (const k of klines || []) {
    const ts = Number(k[0]);
    if (!(ts + HOUR <= nowMs)) continue;
    const high = Number(k[2]), low = Number(k[3]), close = Number(k[4]);
    if (!(close > 0 && high > 0 && low > 0)) continue;
    out.push({ ts, high, low, close });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function pctChange(from, to) {
  return (to / from - 1) * 100;
}

// The bar `back` hours before bars[i], found by TIME, never by stepping an
// index: a gap in the series would otherwise turn "6 bars" into 7 hours.
function barHoursBefore(bars, i, back) {
  const target = bars[i].ts - back * HOUR;
  for (let j = i - 1; j >= 0 && bars[j].ts >= target; j--) {
    if (bars[j].ts === target) return bars[j];
  }
  return null;
}

function qualifies(bars, i) {
  const ref = barHoursBefore(bars, i, PUMP_WINDOW_HOURS);
  return ref ? pctChange(ref.close, bars[i].close) >= PUMP_THRESHOLD_PCT : false;
}

// Returns the day's setup if the LATEST closed bars hold one that has not gone
// stale, else null with a reason. `bars` must be closedHourBars() output that
// reaches back to the start of the current UTC day plus a further 25 hours.
export function detectPump(bars, { maxLagBars = MAX_LAG_BARS } = {}) {
  if (!bars || bars.length < 26) return { setup: null, reason: 'not enough history' };
  const last = bars.length - 1;
  const day = closeDay(bars[last].ts);

  // The first qualifying bar of the latest bar's UTC day, if any.
  let first = -1;
  for (let i = 0; i <= last; i++) {
    if (closeDay(bars[i].ts) !== day) continue;
    if (qualifies(bars, i)) { first = i; break; }
  }
  if (first < 0) return { setup: null, reason: 'no 10% pump today' };
  const lagBars = last - first;
  if (lagBars > maxLagBars) return { setup: null, reason: `today's first pump was ${lagBars} bars ago` };

  const moves = {};
  for (const h of RUNG_HOURS) {
    const ref = barHoursBefore(bars, first, h);
    if (!ref) return { setup: null, reason: `gap in the series ${h}h before the pump bar` };
    moves[h] = pctChange(ref.close, bars[first].close);
  }
  if (!RUNG_HOURS.every((h) => moves[h] >= 0)) {
    return { setup: null, reason: 'horizons disagree ("now reversing"), not an aligned pump' };
  }
  return {
    setup: {
      barTs: bars[first].ts,
      barCloseTs: bars[first].ts + HOUR,
      signalDay: day,
      barClose: bars[first].close,
      lagBars,
      move1h: moves[1], move3h: moves[3], move6h: moves[6], move24h: moves[24]
    },
    reason: 'aligned pump'
  };
}

export function shortStopPrice(entryPrice, stopPct = STOP_PCT) {
  return entryPrice * (1 + stopPct / 100);
}

// Scores a short opened at `entryPrice` at `entryTs` against bars that start
// at or after the entry. A bar that touches the stop ends the trade at the
// stop, or at its open if it opened beyond the stop (a gap fills worse, never
// better). Otherwise the trade closes at the close of the bar that spans the
// end of the hold. The bar the entry falls inside is included whole, so a
// stop touched in its first minutes counts against the trade: conservative.
// `bars`: [{ ts, open, high, low, close, closeTs }] ascending.
export function settleShort({ entryPrice, entryTs, bars, stopPct = STOP_PCT, holdHours = HOLD_HOURS }) {
  const stop = shortStopPrice(entryPrice, stopPct);
  const endTs = entryTs + holdHours * HOUR;
  let maxAdverse = 0, maxFavourable = 0, lastClose = null, lastCloseTs = null;
  for (const b of bars || []) {
    if (b.closeTs <= entryTs || b.ts >= endTs) continue;
    if (b.open >= stop) {
      return finish(entryPrice, Math.max(b.open, stop), b.ts, 'stop', Math.max(maxAdverse, pctChange(entryPrice, b.high)), maxFavourable);
    }
    if (b.high >= stop) {
      return finish(entryPrice, stop, b.ts, 'stop', Math.max(maxAdverse, pctChange(entryPrice, b.high)), Math.max(maxFavourable, -pctChange(entryPrice, b.low)));
    }
    maxAdverse = Math.max(maxAdverse, pctChange(entryPrice, b.high));
    maxFavourable = Math.max(maxFavourable, -pctChange(entryPrice, b.low));
    lastClose = b.close; lastCloseTs = b.closeTs;
  }
  // Settle only a complete hold: a ledger row must never be scored on a
  // partial window and then left looking final.
  if (lastClose == null || lastCloseTs < endTs) return null;
  return finish(entryPrice, lastClose, lastCloseTs, 'time', maxAdverse, maxFavourable);
}

function finish(entry, exit, exitTs, reason, maxAdverse, maxFavourable) {
  return {
    exitPrice: exit, exitTs, exitReason: reason,
    grossPct: -pctChange(entry, exit),
    maxAdversePct: maxAdverse, maxFavourablePct: maxFavourable
  };
}

// A short RECEIVES positive funding and pays negative. Sum of the rates
// charged while it was open, in percent of notional.
export function shortFundingPct(rates) {
  return (rates || []).reduce((s, r) => s + Number(r || 0), 0) * 100;
}

export function netPct({ grossPct, fundingPct = 0, costPct = COST_PCT }) {
  return grossPct + fundingPct - costPct;
}

// Ledger summary, clustered by signal day: pumps arrive in bursts on the same
// day, and counting them as independent trades overstates the evidence.
export function summariseLedger(rows) {
  // Number(null) is 0, so an unsettled row must be excluded explicitly or it
  // would count as a flat trade.
  const done = (rows || []).filter((r) => r.net_pct != null && Number.isFinite(Number(r.net_pct)));
  if (!done.length) return { n: 0 };
  const byDay = new Map();
  for (const r of done) {
    if (!byDay.has(r.signal_day)) byDay.set(r.signal_day, []);
    byDay.get(r.signal_day).push(Number(r.net_pct));
  }
  const dayMeans = [...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const m = mean(dayMeans);
  const sd = dayMeans.length > 1 ? Math.sqrt(dayMeans.reduce((s, x) => s + (x - m) ** 2, 0) / (dayMeans.length - 1)) : null;
  const nets = done.map((r) => Number(r.net_pct));
  return {
    n: done.length,
    days: dayMeans.length,
    meanNetPct: mean(nets),
    winRate: nets.filter((x) => x > 0).length / nets.length,
    stopRate: done.filter((r) => r.exit_reason === 'stop').length / done.length,
    meanFundingPct: mean(done.map((r) => Number(r.funding_pct || 0))),
    dayClusteredT: sd ? m / (sd / Math.sqrt(dayMeans.length)) : null
  };
}
