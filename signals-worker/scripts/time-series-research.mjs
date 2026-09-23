// The time-series lane's public summary: trend, seasonality, cycles,
// variations and irregularities for the market and every always-tracked asset,
// next to the evidence that says which of those readings forecast anything.
//
// The split that matters, measured by the candidate field on 2026-09-23
// (docs/TIME_SERIES_EVIDENCE.md): the SIZE of the next move is forecastable --
// GARCH with a weekday factor beats the production scale out of sample, in
// both halves of history -- and its DIRECTION is not: ARIMA and the structural
// model, the two time-series direction candidates, clear nothing after costs.
// So this section publishes a volatility band and describes everything else.
// The verdicts below are recomputed from each run's own zoo, never hard-coded,
// so a regime in which the evidence reverses is reported as reversed.

import { describeTimeSeries, holmAdjust, TIME_SERIES_VERSION } from './time-series.mjs';
import { ALWAYS_TRACKED } from './tracked-data-quality.mjs';

export const MARKET_SERIES = Object.freeze([
  { symbol: 'MCAP:BROAD', assetClass: 'market', label: 'Crypto market',
    note: 'Equal-weighted composite of the archived coins alive on each date. It holds only coins that survived to today, so its long-run drift reads high.' },
  { symbol: 'SPY', assetClass: 'benchmark', label: 'US stock market', note: 'S&P 500 ETF (SPY).' }
]);

// Test families corrected across the displayed series. The same test run on
// ten series will clear an uncorrected 5% bar somewhere about 40% of the time.
const FAMILIES = [
  // One family per trend window: ten series each get a 30-day reading, and a
  // |t| near 2 somewhere among them is what chance delivers.
  ['trend30', a => a.trend?.windows?.find(w => w.days === 30)],
  ['trend90', a => a.trend?.windows?.find(w => w.days === 90)],
  ['trend365', a => a.trend?.windows?.find(w => w.days === 365)],
  ['weekdayVolatility', a => a.seasonality?.volatility],
  ['weekdayDirection', a => a.seasonality?.direction],
  ['cycle', a => a.cycles],
  ['varianceRatio5', a => a.cycles?.varianceRatio5],
  ['varianceRatio20', a => a.cycles?.varianceRatio20]
];

const cohortEvidence = (zoo, cohort = 'established') => {
  const ts = zoo?.timeSeries;
  if (!ts || ts.status) return null;
  const h2h = ts.headToHead?.garchWeekdayVol_vs_trailingVol?.byCohort?.[cohort];
  const band = ts.intervals?.[cohort]?.models;
  const field = zoo.byCohort?.[cohort]?.field || {};
  const direction = name => {
    const d = field[name]?.direction;
    return d && !d.status ? { hitRate: d.hitRate, netPct: d.netPct, netT: d.netT, forecasts: d.forecasts } : null;
  };
  const halvesAgree = h2h && !h2h.status
    && [h2h.firstHalf?.qlikeT, h2h.secondHalf?.qlikeT].every(t => Number.isFinite(t) && t < 0);
  const verdict = !h2h || h2h.status ? 'insufficient'
    : h2h.qlikeT <= -2 && halvesAgree ? 'improves'
      : h2h.qlikeT >= 2 ? 'worse' : 'no-clear-difference';
  const dirs = { arima: direction('arima'), structural: direction('structural') };
  const anyDirection = Object.values(dirs).some(d => d && Number.isFinite(d.netT) && d.netT >= 2);
  return {
    cohort,
    magnitude: h2h && !h2h.status ? {
      comparison: 'garchWeekdayVol vs trailingVol', verdict,
      forecasts: h2h.forecasts, qlikeT: h2h.qlikeT,
      qlikeTFirstHalf: h2h.firstHalf?.qlikeT ?? null, qlikeTSecondHalf: h2h.secondHalf?.qlikeT ?? null,
      spearmanCandidate: h2h.spearmanCandidate, spearmanIncumbent: h2h.spearmanIncumbent
    } : { verdict: 'insufficient' },
    band: band ? {
      trailingVol: band.trailingVol, garchWeekdayVol: band.garchWeekdayVol
    } : null,
    direction: { ...dirs, verdict: anyDirection ? 'candidate' : 'no-skill' }
  };
};

/**
 * Build the section from the research panel and the prediction lanes that
 * runPrediction already scored. `prediction` is optional: without it the
 * readings are still produced, and every verdict says `not-computed` rather
 * than borrowing a number from somewhere else.
 */
export function buildTimeSeriesSection(panel, { asOf, prediction = null } = {}) {
  const specs = [
    ...MARKET_SERIES.map(m => ({ ...m, group: 'market' })),
    ...ALWAYS_TRACKED.map(symbol => ({ symbol, assetClass: 'crypto', label: symbol, group: 'tracked' }))
  ];
  const assets = {};
  for (const spec of specs) {
    const found = panel.assets.find(a => a.symbol === spec.symbol
      && (a.assetClass === spec.assetClass || (spec.assetClass === 'benchmark' && a.symbol === 'SPY')));
    const base = { label: spec.label, group: spec.group, assetClass: spec.assetClass, note: spec.note ?? null };
    if (!found) { assets[spec.symbol] = { ...base, status: 'no-archive' }; continue; }
    try {
      assets[spec.symbol] = { ...base, ...describeTimeSeries(found.bars, { assetClass: spec.assetClass, asOf }) };
    } catch (error) {
      // One series failing to fit must not take the others down with it.
      assets[spec.symbol] = { ...base, status: 'failed', error: String(error?.message || error) };
    }
  }
  const measured = Object.values(assets).filter(a => a.status === 'measured' || a.status === 'stale');
  for (const [name, pick] of FAMILIES) {
    const holders = measured.map(pick);
    const adjusted = holmAdjust(holders.map(h => h?.pValue));
    holders.forEach((h, i) => { if (h) h.adjustedP = adjusted[i] == null ? null : Number(adjusted[i].toFixed(4)); });
    for (const h of holders) if (h) h.familySize = holders.filter(x => Number.isFinite(x?.pValue)).length;
    // A trend window "clears noise" only after the correction, not before.
    if (name.startsWith('trend')) for (const h of holders) if (h) h.distinguishable = h.adjustedP != null && h.adjustedP < 0.05;
  }
  const lane = key => (prediction?.[key]?.zoo ? cohortEvidence(prediction[key].zoo) : { status: 'not-computed' });
  return {
    version: TIME_SERIES_VERSION, asOf, status: 'shadow', actionable: false,
    assets,
    evidence: { crypto1d: lane('crypto|1'), crypto7d: lane('crypto|7'), stock1d: lane('stock|1'), stock5d: lane('stock|5') },
    limitations: [
      'Trend, cycle and weekday-direction readings are descriptive. The time-series direction models (ARIMA, structural) showed no out-of-sample skill after costs, so none of these is a call.',
      'The volatility band is a SIZE forecast from GARCH(1,1) with a weekday factor, sized by a conformal radius. It says how far, never which way.',
      'Weekday factors are shrunk toward no effect (DerSimonian-Laird) and every p-value is Holm-adjusted across the displayed series.',
      'A cycle is reported only if a periodicity in standardized returns survives correction. Smoothing a random walk produces cycles that are not there.',
      'Walk-forward research over archived daily closes; not an executable track record. Costs, funding and impact are not modelled.'
    ]
  };
}
