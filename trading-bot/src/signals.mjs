// Consumes the SAME public JSON this project's own dashboard renders from
// (frontiercapitalsignals.com/signals/api/signals, /api/intraday) rather
// than re-implementing any scoring logic or reaching into D1 directly —
// one source of truth, and the bot never needs Cloudflare credentials at
// all (smaller blast radius if the VM is ever compromised: worst case
// exposes Binance keys, not the whole signals infrastructure).
import { config } from './config.mjs';

export async function fetchSignals() {
  const res = await fetch(`${config.signalsBase}/api/signals`);
  if (!res.ok) throw new Error(`signals fetch failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchIntraday() {
  const res = await fetch(`${config.signalsBase}/api/intraday`);
  if (!res.ok) throw new Error(`intraday fetch failed: HTTP ${res.status}`);
  return res.json();
}

// Binance Futures is crypto-only (no equities), so only crypto.breakout /
// crypto.breakdown ever become trade candidates — stocks.* is fetched by
// the dashboard's own JSON but has no tradable counterpart on this
// account and is ignored here.
//
// breakout = bullish setup candidates, breakdown = bearish/short setup
// candidates (this is what BUCKET the asset landed in — `score` itself is
// a magnitude/conviction number, not a signed direction).
//
// intradaySignal's `dir` is deliberately NOT surfaced here as a trade
// trigger: this project's own validated research (correlation_research_
// findings, hypotheses intraday_reversal_15/30/60min) found dir's
// momentum-continuation call has a real but MODEST mean-reversion tilt
// conditional on the market actually moving (54-56%, not a clean edge),
// and a large share of outcomes are simply flat. `bottomed`/`peaked` are
// a different, more defensible signal (proximity to a real 24h extreme)
// that's what the user's own fear-greed-reversal instruction actually
// describes — that's the one used for the aggression-boost condition.
export function buildCandidates(signals, intraday) {
  const bottomedBySymbol = Object.fromEntries((intraday?.watchlist || []).filter((w) => w.bottomed).map((w) => [w.symbol, true]));
  const peakedBySymbol = Object.fromEntries((intraday?.watchlist || []).filter((w) => w.peaked).map((w) => [w.symbol, true]));

  const toCandidate = (entry, side) => ({
    symbol: entry.symbol,
    side, // 'BUY' (long, from breakout) or 'SELL' (short, from breakdown)
    price: entry.price,
    rangePos: entry.rangePos,
    range: entry.range,
    confidenceRatio: entry.conf?.total ? entry.conf.agree / entry.conf.total : 0,
    topIndicatorAccuracy: entry.topIndicator?.accuracy ?? 0,
    funding: entry.funding ?? 0,
    reversalFlag: side === 'BUY' ? !!bottomedBySymbol[entry.symbol] : !!peakedBySymbol[entry.symbol],
    drivers: entry.drivers || []
  });

  return [
    ...(signals.crypto?.breakout || []).map((e) => toCandidate(e, 'BUY')),
    ...(signals.crypto?.breakdown || []).map((e) => toCandidate(e, 'SELL'))
  ];
}

export function getFearGreed(signals) {
  return signals.overview?.fear_greed?.value ?? null;
}
