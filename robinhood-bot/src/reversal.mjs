// Bottom-then-established-reversal rule for leveraged US ETFs.
//
// Pure — no I/O, no broker, no network — so every threshold is testable and
// the rule can be re-validated against history without touching an account.
//
// WHAT THIS IS NOT: a forecast. Every clause is an observation about what
// price has ALREADY done. There is no prediction that a low will hold, only a
// requirement that one was made, that price has since turned by more than this
// asset's own noise, and that the turn is still intact today.
//
// Measured over 5,020 daily bars across 10 leveraged ETFs (2024-09 to
// 2026-09): with FIXED percentage thresholds the rule lost on 8 of 10 symbols
// and the median trade was exactly the stop — a 10% stop sits inside the noise
// of an asset with a 10-25% weekly range. Rescaling every threshold to the
// asset's own measured sigma flipped it to 7 of 10 profitable, median +25.4%
// compounded, consistent across three parameter sets.
//
// That is promising, NOT proven: 54 trades in total, 2-9 per symbol. It also
// still loses on the structurally decaying products (MSTU -81%, TSDD -42%),
// and on the assets worth owning it underperforms simply holding them. It runs
// shadow-first for that reason.

// Sample standard deviation of daily returns over the trailing window,
// computed strictly from bars BEFORE the decision bar. The one number every
// threshold is expressed in, so a bar that is ordinary for SOXL is not
// mistaken for a signal because it would be extraordinary for TQQQ.
export function dailySigma(closes, endIndex, lookback = 60) {
  const start = Math.max(1, endIndex - lookback + 1);
  const rets = [];
  for (let i = start; i <= endIndex; i++) {
    const prev = closes[i - 1], cur = closes[i];
    if (prev > 0 && cur > 0) rets.push(cur / prev - 1);
  }
  if (rets.length < 6) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
}

export const DEFAULTS = {
  lookback: 120,      // sessions defining "the low"
  maxLowAge: 15,      // the low must be CURRENT, not a distant memory
  confirmSigmas: 1.5, // how far off the low price must have turned
  targetSigmas: 6,
  stopSigmas: 4,
  maxHoldDays: 25,
  sigmaWindow: 60
};

// Evaluates one asset on one day. `bars` are {date, open, high, low, close}
// oldest-first; `i` is the decision bar. Returns a verdict either way — a
// refusal carries its numbers so a skipped day is auditable rather than silent.
export function evaluate(bars, i, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Array.isArray(bars) || i < o.lookback || i >= bars.length) {
    return { qualifies: false, reason: 'not enough history for a 120-session low' };
  }
  const closes = bars.map((b) => b.close);
  const sigma = dailySigma(closes, i, o.sigmaWindow);
  if (!sigma || !(sigma > 0)) {
    return { qualifies: false, reason: 'no measurable dispersion to scale thresholds against' };
  }

  const window = bars.slice(i - o.lookback, i + 1);
  let low = Infinity, lowIdx = -1;
  window.forEach((b, k) => { if (b.low < low) { low = b.low; lowIdx = k; } });
  const lowAge = window.length - 1 - lowIdx;

  const close = bars[i].close;
  const offLow = close / low - 1;
  const needed = o.confirmSigmas * sigma;
  const closedUp = close > bars[i - 1].close;

  const metrics = {
    close, low, lowAge, offLowPct: offLow * 100,
    neededPct: needed * 100, sigmaPct: sigma * 100, closedUp
  };

  // 1. A low must exist AND be current. A 120-session low set four months ago
  //    describes an asset that already recovered; entering on it is not a
  //    reversal trade, it is a momentum trade wearing the wrong label.
  if (lowAge > o.maxLowAge) {
    return { qualifies: false, reason: `the ${o.lookback}-session low is ${lowAge} sessions old (needs <= ${o.maxLowAge})`, metrics };
  }
  // 2. Price must have turned by more than this asset's own noise. Without
  //    this the rule buys the low itself, which is catching the knife.
  if (offLow < needed) {
    return { qualifies: false, reason: `only ${(offLow * 100).toFixed(1)}% off the low, needs ${(needed * 100).toFixed(1)}% (${o.confirmSigmas}σ)`, metrics };
  }
  // 3. The turn must still be intact on the decision day itself.
  if (!closedUp) {
    return { qualifies: false, reason: 'closed lower than the previous session — the turn is not holding', metrics };
  }

  return {
    qualifies: true,
    reason: `${o.lookback}-session low ${lowAge} sessions ago, price +${(offLow * 100).toFixed(1)}% off it (needs ${(needed * 100).toFixed(1)}%), closed up`,
    metrics,
    entry: close,
    // Exits scale with the same sigma, so the stop sits OUTSIDE this asset's
    // ordinary daily movement rather than inside it.
    target: close * (1 + o.targetSigmas * sigma),
    stop: close * (1 - o.stopSigmas * sigma),
    maxHoldDays: o.maxHoldDays,
    sigma
  };
}

// Resolves an open shadow position against subsequent bars. When one bar spans
// both the stop and the target, it resolves as the STOP: daily bars cannot
// order the two, so it takes the unflattering reading rather than the
// flattering one. That single choice is the difference between an honest
// backtest and the +122% look-ahead artefact this rule replaced.
export function resolve(position, bars, fromIndex) {
  const { entry, target, stop, maxHoldDays } = position;
  const last = Math.min(fromIndex + maxHoldDays, bars.length - 1);
  for (let j = fromIndex; j <= last; j++) {
    if (bars[j].low <= stop) return { exitPrice: stop, reason: 'stop', returnPct: (stop / entry - 1) * 100, index: j, date: bars[j].date };
    if (bars[j].high >= target) return { exitPrice: target, reason: 'target', returnPct: (target / entry - 1) * 100, index: j, date: bars[j].date };
  }
  if (last >= bars.length - 1 && last - fromIndex < maxHoldDays) return null; // still open
  const b = bars[last];
  return { exitPrice: b.close, reason: 'time', returnPct: (b.close / entry - 1) * 100, index: last, date: b.date };
}

// Structural classification, kept explicit because it decides what a "bottom"
// even means for the instrument.
//
// A bottom in a leveraged LONG ETF is a bet the underlying recovers, amplified
// — the leverage works with you. A bottom in an INVERSE ETF is a bet the
// underlying falls, and daily-reset decay works against you the whole time.
// Both are tradeable; they are not the same trade, and pooling their results
// would hide which one the evidence actually supports.
export const INVERSE = new Set(['PLTZ', 'TSDD', 'SQQQ', 'SOXS', 'NVDD', 'MSTZ', 'CONI', 'TZA', 'LABD']);
export const classify = (symbol) => (INVERSE.has(String(symbol).toUpperCase()) ? 'inverse' : 'long');
