// Offline research only. OHLC replay is not exchange execution evidence.
// No exchange client, live configuration, or credential imports belong here.
export const REPLAY_VERSION = 'margin-policy-replay-v1';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const median = xs => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function validResearchPolicy(p) {
  return typeof p?.id === 'string' && p.id.length > 0
    && Number.isInteger(p.leverage) && p.leverage >= 5 && p.leverage <= 20
    && finite(p.stopRoiPct) && p.stopRoiPct >= 10 && p.stopRoiPct <= 30
    && p.firstTargetRoiPct === 60 && p.finalTargetRoiPct === 120
    && finite(p.firstFraction) && p.firstFraction >= 0.5 && p.firstFraction <= 0.75;
}

export function replayPolicy(event, policy) {
  const unavailable = reason => ({ status: reason, netRoiPct: null, liveEligible: false });
  if (!validResearchPolicy(policy)) return unavailable('invalid-policy');
  if (!event || typeof event.id !== 'string' || !event.id || !event.symbol
      || !['BUY', 'SELL'].includes(event.side) || event.venue !== 'binance-usdm'
      || event.priceType !== 'mark' || !event.source
      || !finite(event.entryAt) || !finite(event.endAt) || event.endAt <= event.entryAt
      || !finite(event.contextAt) || event.contextAt > event.entryAt
      || !['crypto', 'stock', 'commodity'].includes(event.assetClass)
      || !['bull', 'bear', 'range', 'unknown'].includes(event.regime)
      || !finite(event.entryPrice) || event.entryPrice <= 0
      || !Number.isInteger(event.intervalMs) || event.intervalMs < 1000 || event.intervalMs > 300_000
      || !Array.isArray(event.bars) || !event.bars.length
      || event.endAt - event.entryAt !== event.bars.length * event.intervalMs) return unavailable('invalid-path');
  const costs = event.costs;
  if (!costs || ![costs.feeRate, costs.slippagePct].every(x => finite(x) && x >= 0)
      || costs.feeRate > 0.01 || costs.slippagePct > 5
      || costs.fundingComplete !== true || !Array.isArray(costs.funding)
      || !costs.source) return unavailable('missing-cost-evidence');
  const funding = costs.funding;
  if (funding.some((f, i) => !finite(f.at) || f.at < event.entryAt || f.at > event.endAt
      || !finite(f.rate) || Math.abs(f.rate) > 0.1 || !finite(f.markPrice) || f.markPrice <= 0
      || (i > 0 && f.at <= funding[i - 1].at))) return unavailable('invalid-funding');
  // Validate the ENTIRE observation window before replay. Do not hide data
  // holes by exiting before them for one favored parameter combination.
  for (let i = 0; i < event.bars.length; i++) {
    const b = event.bars[i];
    if (b?.at !== event.entryAt + i * event.intervalMs
        || ![b.open, b.high, b.low, b.close].every(x => finite(x) && x > 0)
        || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) {
      return unavailable('invalid-path');
    }
  }
  const sign = event.side === 'BUY' ? 1 : -1;
  // Entry is an assumed reference fill, explicitly stressed for slippage.
  const entry = event.entryPrice * (1 + sign * costs.slippagePct / 100);
  const level = roi => entry * (1 + sign * roi / (100 * policy.leverage));
  const stop = level(-policy.stopRoiPct);
  const first = level(policy.firstTargetRoiPct);
  const final = level(policy.finalTargetRoiPct);
  let remaining = 1;
  let firstDone = false;
  let gross = 0;
  let fees = costs.feeRate * policy.leverage * 100;
  let fundingRoi = 0;
  let fundingIndex = 0;
  let exitAt = null;
  const exits = [];
  const close = (fraction, price, at, reason) => {
    const fill = price * (1 - sign * costs.slippagePct / 100);
    gross += fraction * sign * (fill / entry - 1) * policy.leverage * 100;
    fees += fraction * fill / entry * costs.feeRate * policy.leverage * 100;
    remaining = Math.max(0, remaining - fraction);
    exits.push({ fraction, referencePrice: price, simulatedFill: fill, at, reason });
    if (remaining === 0) exitAt = at;
  };
  for (const b of event.bars) {
    if (remaining === 0) break;
    const end = b.at + event.intervalMs;
    const adverse = sign === 1 ? b.low <= stop : b.high >= stop;
    const favorable = price => sign === 1 ? b.high >= price : b.low <= price;
    const gapStop = sign === 1 ? b.open <= stop : b.open >= stop;
    const gapFirst = sign === 1 ? b.open >= first : b.open <= first;
    const gapFinal = sign === 1 ? b.open >= final : b.open <= final;
    // Funding exactly on a bar boundary is charged before a possible exit.
    while (funding[fundingIndex]?.at === b.at) {
      const f = funding[fundingIndex++];
      fundingRoi -= sign * f.rate * f.markPrice / entry * policy.leverage * 100 * remaining;
    }
    if (gapStop) { close(remaining, b.open, b.at, 'gap-stop'); break; }
    if (gapFinal) { close(remaining, b.open, b.at, 'gap-final'); break; }
    if (!firstDone && gapFirst) {
      close(policy.firstFraction, b.open, b.at, 'first-profit');
      firstDone = true;
    }
    if (adverse && favorable(firstDone ? final : first)) return unavailable('ambiguous-intrabar-order');
    const canExit = adverse || favorable(firstDone ? final : first);
    const insideFunding = [];
    while (fundingIndex < funding.length && funding[fundingIndex].at < end) {
      insideFunding.push(funding[fundingIndex++]);
    }
    if (canExit && insideFunding.length) return unavailable('ambiguous-funding-order');
    for (const f of insideFunding) {
      fundingRoi -= sign * f.rate * f.markPrice / entry * policy.leverage * 100 * remaining;
    }
    if (adverse) close(remaining, stop, end, 'stop');
    else {
      if (!firstDone && favorable(first)) {
        close(policy.firstFraction, first, end, 'first-profit');
        firstDone = true;
      }
      if (favorable(final)) close(remaining, final, end, 'final-profit');
    }
  }
  if (remaining > 0) {
    while (funding[fundingIndex]?.at === event.endAt) {
      const f = funding[fundingIndex++];
      fundingRoi -= sign * f.rate * f.markPrice / entry * policy.leverage * 100 * remaining;
    }
    close(remaining, event.bars.at(-1).close, event.endAt, 'window-end');
  }
  return { status: 'simulated', method: REPLAY_VERSION, liveEligible: false,
    grossRoiPct: gross, feeRoiPct: fees, fundingRoiPct: fundingRoi,
    netRoiPct: gross - fees + fundingRoi, exits, exitAt,
    caveat: 'mark-OHLC approximation; assumes executable reference prices; not fill or latency evidence' };
}

// Selection uses training ONLY. Held-out measurements never determine the
// winner, authorize trading, or establish a statistical probability of edge.
export function comparePolicies(events, policies, { cutoffAt, baselineId, asOf = Date.now(), minTrain = 30, minValidation = 20, conditionOnMonth = true } = {}) {
  if (!Array.isArray(events) || !Array.isArray(policies) || !policies.length || policies.length > 32
      || events.length > 5000 || events.reduce((n, e) => n + (Array.isArray(e?.bars) ? e.bars.length : 0), 0) > 250_000
      || !finite(cutoffAt) || !finite(asOf) || cutoffAt > asOf || typeof conditionOnMonth !== 'boolean' || !policies.every(validResearchPolicy)
      || new Set(policies.map(p => p.id)).size !== policies.length
      || !policies.some(p => p.id === baselineId)
      || !Number.isInteger(minTrain) || minTrain < 30 || !Number.isInteger(minValidation) || minValidation < 20) {
    throw new Error('invalid bounded comparison configuration');
  }
  const result = { method: REPLAY_VERSION, liveEligible: false, selectionBasis: 'training median net margin ROI',
    trials: policies.length, cutoffAt, asOf, excluded: {}, cells: [] };
  const exclude = reason => { result.excluded[reason] = (result.excluded[reason] || 0) + 1; };
  const identities = new Set();
  const cells = new Map();
  const priorEnd = new Map();
  for (const e of [...events].sort((a, b) => (a?.entryAt ?? 0) - (b?.entryAt ?? 0))) {
    if (!e || typeof e.id !== 'string' || !e.id) { exclude('invalid-event'); continue; }
    if (identities.has(e.id)) throw new Error(`duplicate event id: ${e.id}`);
    identities.add(e.id);
    if (finite(e.endAt) && e.endAt > asOf) { exclude('unmatured-window'); continue; }
    if (e.entryAt < cutoffAt && e.endAt >= cutoffAt) { exclude('split-boundary-overlap'); continue; }
    const replay = policies.map(p => replayPolicy(e, p));
    const unavailable = replay.find(r => r.status !== 'simulated');
    if (unavailable) { exclude(unavailable.status); continue; }
    // Same common sample for EVERY policy; do not compare a policy on just
    // those bars that happen not to be ambiguous for its chosen thresholds.
    const instrument = `${e.venue}|${e.assetClass}|${e.symbol}`;
    if (e.entryAt < (priorEnd.get(instrument) ?? -Infinity)) { exclude('overlapping-asset-window'); continue; }
    priorEnd.set(instrument, e.endAt);
    const month = conditionOnMonth ? new Date(e.entryAt).getUTCMonth() + 1 : null;
    const key = `${instrument}|${e.side}|${e.regime}|${month ?? 'all-months'}`;
    if (!cells.has(key)) cells.set(key, { key, symbol: e.symbol, side: e.side, regime: e.regime, month,
      training: [], validation: [] });
    cells.get(key)[e.endAt < cutoffAt ? 'training' : 'validation'].push(replay.map(r => r.netRoiPct));
  }
  const summarize = xs => ({ n: xs.length, meanNetRoiPct: mean(xs), medianNetRoiPct: median(xs),
    worstNetRoiPct: xs.length ? Math.min(...xs) : null,
    winFraction: xs.length ? xs.filter(x => x > 0).length / xs.length : null });
  for (const cell of cells.values()) {
    const training = policies.map((p, i) => ({ policyId: p.id,
      ...summarize(cell.training.map(r => r[i])) }));
    // Stable ID tie-break is independent of validation outcomes.
    const ranked = [...training].sort((a, b) => (b.medianNetRoiPct ?? -Infinity) - (a.medianNetRoiPct ?? -Infinity)
      || a.policyId.localeCompare(b.policyId));
    const selected = cell.training.length >= minTrain ? ranked[0].policyId : null;
    const baseIndex = policies.findIndex(p => p.id === baselineId);
    const selectedIndex = policies.findIndex(p => p.id === selected);
    const enough = selected != null && cell.validation.length >= minValidation;
    result.cells.push({ key: cell.key, symbol: cell.symbol, side: cell.side, regime: cell.regime, month: cell.month,
      status: enough ? 'descriptive-validation-only' : 'insufficient-data', selectedOnTraining: selected,
      training, validation: selected == null ? null : summarize(cell.validation.map(r => r[selectedIndex])),
      pairedImprovementVsBaseline: selected == null ? null
        : summarize(cell.validation.map(r => r[selectedIndex] - r[baseIndex])),
      liveEligible: false });
  }
  result.caveats = ['Season/regime labels must be known at entry; month is UTC.',
    'No significance claim, automatic promotion, independent-sample claim or portfolio/liquidation model.',
    'Ambiguous paths excluded across ALL policies; inspect exclusions for selection bias.',
    'Archive coverage and survivorship must be audited separately; more data does not remove overfitting.'];
  return result;
}
