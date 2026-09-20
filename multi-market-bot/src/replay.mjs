import { MARKETS, VERSION, validateSeries, indicators, signalAt, sizeLong } from './strategies.mjs';

// Each symbol is an independent cash account. Never sum these as one portfolio.
export function replay(series, { asOf, startAt, initialEquity = 10_000, slippageBps = 5 } = {}) {
  const spec = validateSeries(series, asOf), bars = series.bars, stats = indicators(bars);
  if (!Number.isFinite(startAt) || !Number.isFinite(initialEquity) || initialEquity <= 0
      || !Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 100) throw new Error('Invalid replay settings');
  const first = bars.findIndex(b => b.at >= startAt);
  const warmup = spec.strategy === 'trend' ? 201 : 21;
  if (first < warmup || first >= bars.length - 1) throw new Error('Insufficient warmup or evaluation bars');
  let cash = initialEquity, position = null, peak = initialEquity, maxDrawdownPct = 0, halted = false;
  let pending = null;
  const trades = [], curve = [];
  const fee = spec.feeBps / 10_000, slip = slippageBps / 10_000;
  const close = (rawPrice, at, reason) => {
    const fill = rawPrice * (1 - slip);
    const proceeds = position.qty * fill * (1 - fee);
    cash += proceeds;
    trades.push({ ...position, exitAt: at, exit: fill, reason, netPnl: proceeds - position.cost });
    position = null;
  };
  const mark = (price, at) => {
    // Net liquidation value includes assumed exit fees and slippage.
    const equity = cash + (position ? position.qty * price * (1 - slip) * (1 - fee) : 0);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
    if ((peak - equity) / peak >= 0.10) halted = true;
    curve.push({ at, equity });
    return equity;
  };
  for (let i = first; i < bars.length; i++) {
    const b = bars[i];
    // A close-based decision can only execute at a later bar's opening price.
    if (position && (b.open <= position.stop || halted || pending?.exit)) {
      close(b.open, b.at, b.open <= position.stop ? 'gap-stop' : halted ? 'drawdown-halt' : 'signal-exit');
    }
    mark(b.open, b.at);
    if (!position && !halted && pending?.enter) {
      const entry = b.open * (1 + slip), stop = entry - spec.stopAtr * pending.atr;
      const qty = sizeLong({ equity: cash, cash, entry, stop, feeBps: spec.feeBps, slippageBps });
      if (qty > 0) {
        const cost = qty * entry * (1 + fee);
        position = { entryAt: b.at, signalAt: pending.at, entry, stop, initialStop: stop, qty, cost };
        cash -= cost;
      }
    }
    // The stop was fixed before this bar's range. Never use this bar's high
    // to tighten a stop and then claim it was hit earlier in the same bar.
    if (position && b.low <= position.stop) close(Math.min(b.open, position.stop), b.end, 'stop');
    mark(b.close, b.end);
    if (position && spec.strategy !== 'mean-reversion' && stats[i].atr > 0) {
      position.stop = Math.max(position.stop, b.close - spec.stopAtr * stats[i].atr);
    }
    pending = { ...signalAt(series.symbol, bars, stats, i), at: b.end };
  }
  if (position) close(bars.at(-1).close, bars.at(-1).end, 'sample-end');
  mark(bars.at(-1).close, bars.at(-1).end);
  const wins = trades.filter(t => t.netPnl > 0), losses = trades.filter(t => t.netPnl < 0);
  const gain = wins.reduce((s, t) => s + t.netPnl, 0), loss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const buyHoldQty = initialEquity / (bars[first].open * (1 + slip) * (1 + fee));
  const buyHoldFinal = buyHoldQty * bars.at(-1).close * (1 - slip) * (1 - fee);
  return { version: VERSION, liveEligible: false, symbol: series.symbol,
    startAt: bars[first].at, endAt: bars.at(-1).end, initialEquity,
    costs: { feeBpsPerSide: spec.feeBps, slippageBpsPerSide: slippageBps },
    finalEquity: cash, netReturnPct: (cash / initialEquity - 1) * 100,
    buyHoldReturnPct: (buyHoldFinal / initialEquity - 1) * 100,
    maxDrawdownPct, halted, tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: loss > 0 ? gain / loss : null,
    trades, curve };
}

export function researchReport(dataset) {
  if (dataset?.version !== 1 || !Array.isArray(dataset.series) || dataset.series.length !== 5
      || new Set(dataset.series.map(s => s.symbol)).size !== 5) throw new Error('Expected all five unique markets');
  const results = dataset.series.map(series => {
    const spec = validateSeries(series, dataset.asOf);
    const first = spec.strategy === 'trend' ? 201 : 21;
    const cutoffIndex = first + Math.floor((series.bars.length - first) * 0.7);
    if (cutoffIndex <= first || cutoffIndex >= series.bars.length - 1) throw new Error('Insufficient history');
    const cutoffAt = series.bars[cutoffIndex].at;
    const training = { ...series, bars: series.bars.slice(0, cutoffIndex) };
    const settings = { asOf: dataset.asOf, startAt: series.bars[first].at };
    return { symbol: series.symbol, source: series.source, dataQuality: series.dataQuality,
      barCount: series.bars.length, cutoffAt,
      earlySample: replay(training, settings),
      laterSample: replay(series, { ...settings, startAt: cutoffAt }),
      laterStress: replay(series, { ...settings, startAt: cutoffAt, slippageBps: 15 }) };
  });
  return { version: VERSION, generatedAt: new Date().toISOString(), dataAsOf: dataset.asOf,
    liveEligible: false, status: 'exploratory-only',
    design: 'Fixed parameters; per-symbol chronological 70/30 split after warmup; fresh cash at each split; no parameter selection.',
    limitations: [
      'Long/cash adaptation; equity shorts and portfolio correlation filter are not simulated.',
      'Separate $10,000 accounts; these results are not combined portfolio returns.',
      'Historical later sample is not an untouched prospective test; no profitability inference.',
      'Yahoo ETF prices and Coinbase BTC candles are not Alpaca executable quotes; venue volume differs.',
      'Histories restart after known gaps; coverage selection and missing entire equity sessions remain limitations without an exchange-calendar audit.',
      'Session-close marking can miss intrabar drawdown; no guaranteed stop loss cap.',
      'Cash interest, distributions, taxes, settlement, order rounding and market impact omitted.',
      'Different history lengths and dates; no monthly-income projection.'
    ], results };
}
