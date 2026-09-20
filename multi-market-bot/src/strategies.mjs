// Independent, fixed long/cash hypotheses. No broker or FCS authorization imports.
export const VERSION = 'multi-market-research-v1';
export const MARKETS = Object.freeze({
  SPY: Object.freeze({ strategy: 'mean-reversion', timeframe: '15m', threshold: 1.5, stopAtr: 1, feeBps: 1 }),
  QQQ: Object.freeze({ strategy: 'mean-reversion', timeframe: '15m', threshold: 1.8, stopAtr: 1, feeBps: 1 }),
  'BTC/USD': Object.freeze({ strategy: 'breakout', timeframe: '1h', stopAtr: 2, feeBps: 25 }),
  GLD: Object.freeze({ strategy: 'trend', timeframe: '4h-session', stopAtr: 3, feeBps: 1 }),
  USO: Object.freeze({ strategy: 'trend', timeframe: '4h-session', stopAtr: 3, feeBps: 1 }),
});
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

export function validateSeries(series, asOf) {
  const spec = MARKETS[series?.symbol];
  if (!spec || series.timeframe !== spec.timeframe || !series.source?.trim()
      || !Number.isFinite(asOf) || !Array.isArray(series.bars)
      || series.bars.length < 22 || series.bars.length > 30_000) throw new Error('Invalid series metadata or bar count');
  let previous;
  for (const b of series.bars) {
    if (!['at', 'end', 'open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(b[k]))
        || b.at >= b.end || b.end > asOf || b.open <= 0 || b.low <= 0 || b.volume < 0
        || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)
        || (previous && b.at < previous.end)) throw new Error('Invalid, unfinished, unordered or overlapping bar');
    const duration = b.end - b.at;
    const allowed = spec.timeframe === '15m' ? [900_000] : spec.timeframe === '1h' ? [3_600_000] : [14_400_000, 9_000_000];
    if (!allowed.includes(duration)) throw new Error('Unexpected bar duration');
    if (series.symbol === 'BTC/USD' && previous && b.at !== previous.end) throw new Error(`Missing crypto bar between ${new Date(previous.end).toISOString()} and ${new Date(b.at).toISOString()}`);
    previous = b;
  }
  return spec;
}

export function indicators(bars) {
  const out = [];
  const closes = [], ranges = [];
  let fast = null, slow = null, atr = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    closes.push(b.close);
    ranges.push(i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
    if (i === 13) atr = mean(ranges);
    else if (i > 13) atr = (atr * 13 + ranges[i]) / 14;
    if (i === 49) fast = mean(closes);
    else if (i > 49) fast += 2 / 51 * (b.close - fast);
    if (i === 199) slow = mean(closes);
    else if (i > 199) slow += 2 / 201 * (b.close - slow);
    const window = closes.slice(-20), average = mean(window);
    const sd = Math.sqrt(mean(window.map(c => (c - average) ** 2)));
    const prior = bars.slice(Math.max(0, i - 20), i);
    out.push({ atr, fast, slow, mean: average, z: sd > 0 ? (b.close - average) / sd : null,
      priorHigh: prior.length === 20 ? Math.max(...prior.map(p => p.high)) : null,
      priorLow: prior.length === 20 ? Math.min(...prior.map(p => p.low)) : null,
      priorVolume: prior.length === 20 ? mean(prior.map(p => p.volume)) : null });
  }
  return out;
}

export function signalAt(symbol, bars, stats, i) {
  const spec = MARKETS[symbol], s = stats[i], prev = stats[i - 1];
  if (!spec || i < 20 || !s || !(s.atr > 0)) return { enter: false, exit: false, reason: 'warmup-or-flat' };
  if (spec.strategy === 'mean-reversion') return {
    enter: s.z !== null && s.z < -spec.threshold, exit: bars[i].close >= s.mean,
    reason: 'deviation-from-20-bar-mean', atr: s.atr,
  };
  if (spec.strategy === 'breakout') return {
    enter: s.priorVolume > 0 && bars[i].close > s.priorHigh && bars[i].volume >= s.priorVolume * 1.5,
    exit: bars[i].close < s.priorLow,
    reason: 'prior-20-bar-channel-and-volume', atr: s.atr,
  };
  if (prev?.slow === null || s.slow === null || !prev) return { enter: false, exit: false, reason: 'ema-warmup' };
  return { enter: prev.fast <= prev.slow && s.fast > s.slow,
    exit: prev.fast >= prev.slow && s.fast < s.slow, reason: '50-200-ema-cross', atr: s.atr };
}

// Budget the distance to the actual stop AND assumed round-trip execution costs.
// Gaps can still exceed that budget; this is not a guaranteed loss ceiling.
export function sizeLong({ equity, cash, entry, stop, feeBps, slippageBps, riskFraction = 0.01 }) {
  if (![equity, cash, entry, stop, feeBps, slippageBps, riskFraction].every(Number.isFinite)
      || equity <= 0 || cash <= 0 || entry <= 0 || stop <= 0 || stop >= entry
      || feeBps < 0 || slippageBps < 0 || riskFraction <= 0 || riskFraction > 0.01) return 0;
  const assumedStopFill = stop * (1 - slippageBps / 10_000);
  const lossPerUnit = entry - assumedStopFill + (entry + assumedStopFill) * feeBps / 10_000;
  return Math.max(0, Math.min(equity * riskFraction / lossPerUnit, cash / (entry * (1 + feeBps / 10_000))));
}
