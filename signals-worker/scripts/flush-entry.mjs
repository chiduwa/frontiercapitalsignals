// Turns a detected flush into an entry plan — or into a refusal.
//
// Pure functions, no I/O, so the rules can be tested directly and so the same
// code produces the same plan whether it is called from research, from a
// shadow ledger, or eventually from the bot.
//
// EVERY NUMBER HERE IS MEASURED (docs/FLUSH_EVIDENCE.md, 248 episodes / 30
// symbols / 60 days). Nothing is a round number someone liked.
//
// The four cases, and why only two of them are trades:
//
//   dip + OI FELL      Longs were liquidated out. Genuine flush. Bottoms at a
//                      median 8.45% below the pre-flush high, bounces ~55% of
//                      the drop within 30 minutes. THIS IS THE BUY.
//   dip + OI ROSE      New shorts are pressing in. Bounces HARDER (87% in 30
//                      minutes) and is 13.47% LOWER twelve hours later. The
//                      bounce is bait: buying the 8.45% level here returned a
//                      median -19.31% by the 12-hour mark. REFUSED for longs.
//   spike + OI FELL    Shorts covering. Retraces 106% — it gives the whole
//                      move back. THIS IS THE SELL.
//   spike + OI ROSE    New longs with conviction. Retraces only 51% and is
//                      +10.82% twelve hours later. REFUSED for shorts.
//
// So the rule is not "buy dips deeper". It is "buy only the dips that are
// mechanical, and refuse the ones that are the start of a trend" — which is
// the opposite of what a wider stop would have done.

export const FLUSH_ENTRY_VERSION = 'fcs-flush-entry-v1';

// Entry depth below the pre-flush reference, as a percentage.
//
// Chosen by expected value, not by preference. Deeper fills better but fills
// less often, and the product is flat across a wide band — which is itself the
// useful result, because it means the choice is not delicate:
//
//   depth   fill rate   median gain if filled   EV
//    7.00%     73.7%          +1.98%            1.46
//    8.00%     57.9%          +2.71%            1.57   <- chosen
//    8.45%     48.7%          +3.16%            1.54
//   10.00%     38.2%          +4.09%            1.56
//   12.00%     21.1%          +6.03%            1.27
//
// 8% sits at the top of a flat plateau. The 6% row is excluded on purpose: the
// detector's own trigger is a 6% drop, so "100% of dips reach 6%" is circular
// and its EV is an artefact, not an edge.
export const ENTRY_DEPTH_PCT = 8;

// Stop placement — and this is the single most consequential number here.
//
// p90 of the liquidation-dip trough distribution is 14.7% below the reference.
// Simulating the full plan over the 76 liquidation dips shows the stop is what
// decides whether the strategy makes money at all:
//
//   stop 10%   mean net -0.35%   stopped 29/44   <- LOSES
//   stop 12%   mean net +0.19%   stopped 16/44
//   stop 15%   mean net +0.80%   stopped  7/44   <- chosen
//   stop 20%   mean net +1.70%   stopped  1/44   (but that is nearly no stop,
//                                                 with tail risk this 60-day
//                                                 sample cannot see)
//
// A tight stop does not reduce risk here, it converts a winning setup into a
// losing one — because the flush routinely overshoots the level it bounces
// from. That is precisely the reported experience: a position taken out by a
// sub-five-minute wick that then rebounded.
export const STOP_DEPTH_PCT = 15;

// The corollary nobody can opt out of: a 15% adverse excursion must not be a
// liquidation. At 10x leverage a 15% move is 150% of margin — the position is
// closed by the exchange long before the stop is consulted, which is the
// mechanism that produced the loss this whole study came from.
//
// 3x keeps a full 15% stop at 45% of margin, leaving room for funding and for
// the maintenance-margin buffer. Raising this without re-running the stop
// sensitivity above is how the edge gets given back.
export const MAX_LEVERAGE = 3;

// Measured outcome of the plan on its own sample (76 liquidation dips, 44
// fills), net of 13bp round-trip cost. Stored so a live track record can be
// compared against what was promised rather than against a memory of it.
export const EXPECTED_PERFORMANCE = {
  fillRate: 0.579,
  winRate: 0.795,
  medianNetPct: 2.01,
  meanNetPct: 0.80,
  worstNetPct: -7.61,
  evPerDetectedEventPct: 0.464
};

// Measured 30-minute retrace per case, used to set the target.
export const RETRACE = { liquidationDip: 0.554, squeezeSpike: 1.062 };

// These are SHORT-HOLD trades and the exit is not optional. A liquidation dip
// is 9.69% BELOW its pre-flush price twelve hours later even though it bounced
// 55% within thirty minutes. Holding the bounce gives the gain back and more.
export const MAX_HOLD_MINUTES = 45;

const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// `move` is a detectMove()/flush_event-shaped object.
// Returns { ok:false, reason } or a full plan.
export function planEntry(move, { depthPct = ENTRY_DEPTH_PCT, priorVolPct = null } = {}) {
  if (!move) return { ok: false, reason: 'no move supplied' };
  const ref = finite(move.refPrice);
  const classification = move.classification;
  const direction = move.direction;
  if (!(ref > 0)) return { ok: false, reason: 'no usable reference price' };

  if (classification === 'ambiguous') {
    return { ok: false, reason: 'open interest did not move decisively — the classifying variable is absent, so abstain' };
  }

  // --- the two refusals, which are the point of the whole system ---
  if (direction === 'down' && classification === 'new-position') {
    return {
      ok: false, side: 'BUY',
      reason: 'dip with RISING open interest: new shorts are entering. Measured -13.47% at 12h '
        + 'and -19.31% from an 8.45% entry. The bounce is bait, not a bottom.',
      contraSignal: 'SELL'
    };
  }
  if (direction === 'up' && classification === 'new-position') {
    return {
      ok: false, side: 'SELL',
      reason: 'spike with RISING open interest: new longs with conviction. Retraces only 51% '
        + 'and is +10.82% at 12h. Fading this is fighting a trend.',
      contraSignal: 'BUY'
    };
  }

  // --- the two trades ---
  const isDip = direction === 'down';
  const side = isDip ? 'BUY' : 'SELL';
  const retrace = isDip ? RETRACE.liquidationDip : RETRACE.squeezeSpike;
  const signed = isDip ? -1 : 1;

  const entryPrice = ref * (1 + signed * depthPct / 100);
  const stopPrice = ref * (1 + signed * STOP_DEPTH_PCT / 100);
  // The target is the measured retrace of the move, applied from the entry —
  // not from the trough, which is only knowable afterwards.
  const extreme = finite(move.extremePrice) ?? entryPrice;
  const targetPrice = extreme + (ref - extreme) * retrace;

  const rewardPct = ((targetPrice / entryPrice) - 1) * 100 * signed * -1;
  const riskPct = Math.abs(((stopPrice / entryPrice) - 1) * 100);

  // Prior realized volatility is the one pre-event predictor that measured
  // anything (Spearman +0.246 with retrace, t=3.97): moves erupting from an
  // already-volatile tape come back further. It ADJUSTS confidence, and
  // deliberately does not move the price — one predictor at t≈4 is not enough
  // to re-site an entry on.
  let confidence = 'measured';
  const pv = finite(priorVolPct);
  if (pv != null) confidence = pv >= 0.25 ? 'measured-high-vol' : 'measured-low-vol';

  return {
    ok: true,
    version: FLUSH_ENTRY_VERSION,
    side, direction, classification,
    refPrice: ref, entryPrice, stopPrice, targetPrice,
    depthPct, expectedRetrace: retrace,
    rewardPct, riskPct,
    // Deliberately reported even though it is unflattering: 0.60 on the buy
    // side. The edge is a 79.5% win rate against a wide stop, not a favourable
    // payoff ratio, and anyone sizing this off R:R alone will misjudge it.
    rewardRisk: riskPct > 0 ? rewardPct / riskPct : null,
    maxLeverage: MAX_LEVERAGE,
    maxHoldMinutes: MAX_HOLD_MINUTES,
    expected: EXPECTED_PERFORMANCE,
    confidence,
    rationale: isDip
      ? 'dip with FALLING open interest: longs liquidated out. Mechanical flush, '
        + `median trough 8.45% below reference, ~55% retraced within 30 minutes. `
        + 'Exit on the bounce — 12h return is still -9.69%.'
      : 'spike with FALLING open interest: shorts covering. Retraces ~106% — the move '
        + 'is given back in full. Fade it, and do not hold past the retrace.'
  };
}

// The continuation call the alerting path uses. Rising open interest through a
// move is new money taking that side, and the 12-hour numbers say the move
// keeps going: +10.82% for spikes, -13.47% for dips.
export function continuationCall(move) {
  if (!move || move.classification !== 'new-position') return null;
  const up = move.direction === 'up';
  return {
    symbol: move.symbol ?? null,
    expectation: up ? 'keeps rising' : 'keeps falling',
    median12hPct: up ? 10.82 : -13.47,
    basis: `open interest ${move.oiChangePct == null ? '' : move.oiChangePct.toFixed(1) + '% '}`
      + `ROSE through a ${Math.abs(move.movePct ?? 0).toFixed(1)}% ${up ? 'spike' : 'dip'} — `
      + 'new positioning, not forced closing',
    caution: up
      ? 'retraces only ~51% of the move short-term, so chasing the top is still costly'
      : 'bounces ~87% within 30 minutes first; that bounce is bait, not a bottom'
  };
}
