// The design matrix for the per-asset multiple regression.
//
// One dependent variable (this asset's forward return) against many regressors
// drawn from every archived lane. The blocks exist so that a lane can be tested
// for incremental explanatory power as a group -- "do the derivatives columns
// add anything over price and volume alone" is a nested F test, not an opinion.
//
// Two rules hold everywhere in this file:
//   1. Nothing reads a bar, or a lane row, dated later than the anchor.
//   2. A missing lane becomes zeros PLUS an explicit indicator column. Filling
//      it with a silent zero would tell the regression the feature was measured
//      and found to be average, which is a different and false claim.

import { alignDailyResearchBars } from './archive-policy.mjs';

const DAY = 86400000;
const dateMs = d => Date.parse(`${d}T00:00:00Z`);
const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const clip = (x, bound = 4) => (Number.isFinite(x) ? Math.max(-bound, Math.min(bound, x)) : 0);

export const FEATURE_BLOCKS = {
  momentum: ['return1', 'return5', 'return20', 'return60', 'trendGap'],
  volatility: ['volRatio', 'volOfVol', 'downsideShare'],
  volume: ['volumeRatio', 'volumeTrend'],
  market: ['market5', 'market20', 'relative5', 'beta60'],
  range: ['rangePosition', 'drawdownFromHigh', 'dwellShare'],
  derivatives: ['oiChange1', 'oiChange7', 'oiPercentile', 'oiPriceDivergence', 'takerRatio', 'accountLsChange'],
  // Funding is the PRICE of the open interest the derivatives block measures.
  // Open interest is the one place this project found real per-asset structure
  // (oiChange1 I2=0.94), so the cost of carrying that position belongs beside
  // it. Perpetuals only: an equity has no funding leg, hence an optional block.
  funding: ['fundingRate', 'fundingPercentile', 'fundingChange7'],
  // Market-wide sentiment. One value per DATE, shared by every asset, so it can
  // only be identified in an asset's own time series -- and it will be
  // collinear with the market block by construction. The VIF/Gram-Schmidt pass
  // decides whether it survives; that is the point of having one.
  sentiment: ['fearGreed', 'fearGreedChange7'],
  supply: ['supplyGrowth30', 'supplyOverhang']
};

// Implemented, tested and MEASURED -- and excluded from the production column
// vector, because measuring them is what settled it. Adding funding and
// sentiment made all four lanes worse out of sample, on every metric:
//
//   lane        OOS R2 base -> +blocks      MAE base -> +blocks
//   crypto 1d   -0.00036    -> -0.00218     3.9161   -> 3.9495
//   crypto 7d   -0.0640     -> -0.1202      9.989    -> 10.088
//   stock 1d    -0.0222     -> -0.0265      1.8335   -> 1.8391
//   stock 5d    -0.0230     -> -0.0313      4.3711   -> 4.3977
//
// and no funding or sentiment feature entered the learned-heterogeneity set on
// any lane. In sample they are NOT empty -- funding clears 5% on 58 of 228
// assets against 11.4 expected -- which is this project's standing pattern
// restated: in-sample significance that does not convert. Set
// FCS_EXPERIMENTAL_BLOCKS=1 to include them and re-measure when the archive is
// deeper; the version string changes with them so stored coefficients cannot
// be compared across the two column spaces.
export const EXPERIMENTAL_BLOCKS = ['funding', 'sentiment'];
export const EXPERIMENTAL_BLOCKS_ENABLED =
  (globalThis.process?.env?.FCS_EXPERIMENTAL_BLOCKS ?? '') === '1';
const blockActive = b => EXPERIMENTAL_BLOCKS_ENABLED || !EXPERIMENTAL_BLOCKS.includes(b);

/** Blocks that can be absent for an asset or a date, and so carry an indicator. */
export const OPTIONAL_BLOCKS =
  ['market', 'derivatives', 'funding', 'sentiment', 'supply'].filter(blockActive);
export const BLOCK_NAMES = Object.keys(FEATURE_BLOCKS).filter(blockActive);
const indicatorName = block => `${block}Missing`;

/** Column order is fixed and derived, never hand-maintained, so that a stored
 *  coefficient vector cannot silently re-map onto a different feature. */
export const FEATURE_NAMES = ['intercept',
  ...BLOCK_NAMES.flatMap(b => FEATURE_BLOCKS[b]),
  ...OPTIONAL_BLOCKS.map(indicatorName)];

export const BLOCK_OF = Object.fromEntries([
  ['intercept', 'intercept'],
  ...BLOCK_NAMES.flatMap(b => FEATURE_BLOCKS[b].map(f => [f, b])),
  ...OPTIONAL_BLOCKS.map(b => [indicatorName(b), b])
]);

/** Column indices for a block, including its indicator. Used by the nested tests. */
export function blockColumns(block) {
  return FEATURE_NAMES.map((name, i) => (BLOCK_OF[name] === block ? i : -1)).filter(i => i >= 0);
}

const MIN_HISTORY = 60;

/**
 * Admit only bars that can appear in a regression at all: a real UTC date, a
 * finite positive close, no duplicates, in order.
 *
 * This is not optional hygiene. `asset_daily_bars` is documented to contain
 * corrupt rows, and a single non-positive close turns one log return into
 * -Infinity, which propagates into X'X and kills the whole asset's fit with a
 * message that names no symbol. Quarantine handles the spikes; this handles
 * the values that are not numbers at all.
 */
export function sanitizeBars(bars, { asOf = null } = {}) {
  const seen = new Set();
  const out = [];
  for (const bar of alignDailyResearchBars(bars || []).sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || (!Number.isFinite(dateMs(bar.date)) || new Date(dateMs(bar.date)).toISOString().slice(0, 10) !== bar.date)) continue;
    if (!Number.isFinite(bar.close) || !(bar.close > 0)) continue;
    if (asOf && bar.date >= asOf) continue;
    if (seen.has(bar.date)) continue;
    seen.add(bar.date);
    out.push(bar);
  }
  return out;
}

/** Most recent lane row at or before `date`, within a tolerance in days. */
export function asOfRow(series, date, tolerance = 3) {
  if (!series?.length) return null;
  let best = null;
  for (const row of series) {
    if (row.date > date) break;
    best = row;
  }
  if (!best) return null;
  return (dateMs(date) - dateMs(best.date)) / DAY <= tolerance ? best : null;
}

const ratioChange = (now, then) => (now > 0 && then > 0 ? Math.log(now / then) : null);

/**
 * One row of the design matrix, as known at the close of `bars[i]`.
 * Returns null when the asset's own price history cannot support the window --
 * an asset that cannot be measured must be skipped, never imputed.
 */
export function featureRow(bars, i, {
  benchmarkByDate = new Map(), derivatives = [], supply = [], funding = [],
  sentimentByDate = new Map(), assetClass = 'crypto'
} = {}) {
  if (i < MIN_HISTORY) return null;
  const window = bars.slice(i - MIN_HISTORY, i + 1);
  const maxGap = assetClass === 'crypto' ? 1 : 4;
  if (window.some((b, j) => j && (dateMs(b.date) - dateMs(window[j - 1].date)) / DAY > maxGap)) return null;
  const returns = window.slice(1).map((b, j) => Math.log(b.close / window[j].close));
  const average = mean(returns);
  const vol = Math.sqrt(mean(returns.map(v => (v - average) ** 2)));
  if (!(vol > 1e-6)) return null;
  const price = bars[i].close;
  const date = bars[i].date;
  const values = {};

  // --- momentum: volatility-normalized so a quiet asset and a wild one are
  // measured on the same scale, which is what makes pooling across assets legal.
  const scaledReturn = n => (i - n >= 0 ? Math.log(price / bars[i - n].close) / (vol * Math.sqrt(n)) : null);
  values.return1 = scaledReturn(1);
  values.return5 = scaledReturn(5);
  values.return20 = scaledReturn(20);
  values.return60 = scaledReturn(60);
  values.trendGap = Math.log(price / mean(window.slice(-20).map(b => b.close))) / (vol * Math.sqrt(20));

  // --- volatility regime
  const recent = returns.slice(-10), older = returns.slice(-60, -10);
  const sd = xs => (xs.length > 2 ? Math.sqrt(mean(xs.map(v => (v - mean(xs)) ** 2))) : null);
  const shortVol = sd(recent), longVol = sd(older);
  values.volRatio = shortVol > 0 && longVol > 0 ? Math.log(shortVol / longVol) : null;
  const rollingVol = [];
  for (let k = 10; k < returns.length; k += 5) rollingVol.push(sd(returns.slice(k - 10, k)));
  const usableVol = rollingVol.filter(v => v > 0);
  values.volOfVol = usableVol.length > 3 ? sd(usableVol.map(Math.log)) : null;
  values.downsideShare = returns.length ? returns.filter(v => v < 0).length / returns.length - 0.5 : null;

  // --- volume
  const volumes = window.slice(-20).map(b => b.volume).filter(v => Number.isFinite(v) && v > 0);
  const volumeUsable = volumes.length >= 15 && Number.isFinite(bars[i].volume) && bars[i].volume > 0;
  values.volumeRatio = volumeUsable ? Math.log(bars[i].volume / mean(volumes)) : null;
  const priorVolumes = window.slice(-60, -20).map(b => b.volume).filter(v => Number.isFinite(v) && v > 0);
  values.volumeTrend = volumeUsable && priorVolumes.length >= 20
    ? Math.log(mean(volumes) / mean(priorVolumes)) : null;

  // --- market / benchmark
  const benchAt = n => benchmarkByDate.get(bars[i - n]?.date);
  const benchNow = benchmarkByDate.get(date);
  const marketReturn = n => {
    const then = benchAt(n);
    return then > 0 && benchNow > 0 ? Math.log(benchNow / then) / (vol * Math.sqrt(n)) : null;
  };
  values.market5 = marketReturn(5);
  values.market20 = marketReturn(20);
  values.relative5 = values.market5 == null || values.return5 == null ? null : values.return5 - values.market5;
  const pairs = [];
  for (let k = Math.max(1, i - MIN_HISTORY + 1); k <= i; k++) {
    const a = benchmarkByDate.get(bars[k - 1].date), b = benchmarkByDate.get(bars[k].date);
    if (a > 0 && b > 0) pairs.push([Math.log(bars[k].close / bars[k - 1].close), Math.log(b / a)]);
  }
  if (pairs.length >= 20) {
    const ma = mean(pairs.map(p => p[0])), mb = mean(pairs.map(p => p[1]));
    let bb = 0, ab = 0;
    for (const [x, y] of pairs) { bb += (y - mb) ** 2; ab += (x - ma) * (y - mb); }
    values.beta60 = bb > 0 ? ab / bb : null;
  } else values.beta60 = null;

  // --- range and dwell: the project's existing 52-week concept, as a regressor
  // rather than a hand-set rule, so its sign is learned instead of asserted.
  const long = bars.slice(Math.max(0, i - 251), i + 1).map(b => b.close);
  const high = Math.max(...long), low = Math.min(...long);
  values.rangePosition = high > low ? (price - low) / (high - low) - 0.5 : null;
  values.drawdownFromHigh = high > 0 ? Math.log(price / high) / vol : null;
  const near = bars.slice(Math.max(0, i - 59), i + 1)
    .filter(b => Math.abs(b.close - high) / high < 0.03 || Math.abs(b.close - low) / Math.max(low, 1e-12) < 0.03);
  values.dwellShare = near.length / Math.min(60, i + 1) - 0.5;

  // --- derivatives (crypto only; absent for equities by construction)
  const deriv = assetClass === 'stock' ? null : asOfRow(derivatives, date, 0);
  const derivPrior = n => asOfRow(derivatives, new Date(dateMs(date) - n * DAY).toISOString().slice(0, 10), 0);
  if (deriv && deriv.oi_usd_close > 0) {
    const d1 = derivPrior(1), d7 = derivPrior(7);
    values.oiChange1 = d1 ? ratioChange(deriv.oi_usd_close, d1.oi_usd_close) : null;
    values.oiChange7 = d7 ? ratioChange(deriv.oi_usd_close, d7.oi_usd_close) : null;
    const history = derivatives.filter(r => r.date <= date && r.oi_usd_close > 0).slice(-252).map(r => r.oi_usd_close);
    values.oiPercentile = history.length >= 60
      ? history.filter(v => v <= deriv.oi_usd_close).length / history.length - 0.5 : null;
    // Open interest rising while price falls is a different setup from both
    // rising together; the divergence is the selected cross-sectional feature.
    // Positive when open interest builds against the price move: new money
    // arriving into a falling market, which is the shape the cross-sectional
    // lane selected. Written as an explicit product so the fitted coefficient
    // has one readable meaning.
    values.oiPriceDivergence = values.oiChange1 == null || values.return1 == null
      ? null : -values.oiChange1 * Math.tanh(values.return1);
    values.takerRatio = deriv.taker_buy_sell_ratio > 0 ? Math.log(deriv.taker_buy_sell_ratio) : null;
    const lsPrior = derivPrior(1);
    values.accountLsChange = lsPrior && deriv.all_account_ls > 0 && lsPrior.all_account_ls > 0
      ? Math.log(deriv.all_account_ls / lsPrior.all_account_ls) : null;
  }

  // --- funding (perpetuals only)
  // The raw rate is tiny (mean |rate| 5.6e-4) with occasional prints past 0.5
  // that are squeezes or bad data. tanh keeps the normal range near-linear and
  // bounds the tail instead of letting one print dominate X'X.
  // Gated on class, not on the caller handing over an empty array. There are
  // no stock/crypto symbol collisions in `funding_rate_daily` today (checked:
  // zero), but an equity has no perpetual funding leg as a matter of fact, and
  // a future listing colliding on ticker must not quietly become a regressor.
  const fundingRow = assetClass === 'stock' ? null : asOfRow(funding, date, 0);
  if (fundingRow && Number.isFinite(fundingRow.funding_rate)) {
    values.fundingRate = Math.tanh(fundingRow.funding_rate * 500);
    const prior7 = asOfRow(funding, new Date(dateMs(date) - 7 * DAY).toISOString().slice(0, 10), 0);
    values.fundingChange7 = prior7 && Number.isFinite(prior7.funding_rate)
      ? Math.tanh((fundingRow.funding_rate - prior7.funding_rate) * 500) : null;
    // "Is funding high FOR THIS ASSET" -- the question the archive was built to
    // answer, and the robust one: a percentile cannot be moved by an outlier.
    const history = funding.filter(r => r.date <= date && Number.isFinite(r.funding_rate))
      .slice(-252).map(r => r.funding_rate);
    values.fundingPercentile = history.length >= 60
      ? history.filter(v => v <= fundingRow.funding_rate).length / history.length - 0.5 : null;
  }

  // --- sentiment (market-wide, carried on the symbol='' row for the date)
  // alternative.me's Fear & Greed is a CRYPTO index. Handing it to an equity
  // regression is an unjustified cross-asset borrow, and it measured as one:
  // with stocks receiving it, stock 1d OOS R2 went -0.0222 -> -0.0265 and
  // t -3.43 -> -3.72. Gated here rather than at the call site so there is one
  // place this can be true. `vix_range_pos` would be the equity-appropriate
  // field and is 2.3% populated, so equities simply have no sentiment lane.
  const fg = assetClass === 'stock' ? null : sentimentByDate.get(date);
  if (Number.isFinite(fg)) {
    values.fearGreed = (fg - 50) / 50;
    const prior = sentimentByDate.get(new Date(dateMs(date) - 7 * DAY).toISOString().slice(0, 10));
    values.fearGreedChange7 = Number.isFinite(prior) ? (fg - prior) / 50 : null;
  }

  // --- supply
  const supplyRow = assetClass === 'stock' ? null : asOfRow(supply, date, 3);
  const supplyPrior = asOfRow(supply, new Date(dateMs(date) - 30 * DAY).toISOString().slice(0, 10), 5);
  if (supplyRow && supplyRow.circulating_supply > 0) {
    values.supplyGrowth30 = supplyPrior?.circulating_supply > 0
      ? Math.log(supplyRow.circulating_supply / supplyPrior.circulating_supply) : null;
    values.supplyOverhang = supplyRow.max_supply > 0
      ? (supplyRow.snapshot_circulating_supply ?? supplyRow.circulating_supply) / supplyRow.max_supply - 0.5 : null;
  }

  // --- assemble, recording which optional blocks were actually measured
  const available = {};
  for (const block of BLOCK_NAMES) {
    available[block] = FEATURE_BLOCKS[block].some(f => Number.isFinite(values[f]));
  }
  const x = [1];
  for (const block of BLOCK_NAMES) {
    for (const f of FEATURE_BLOCKS[block]) x.push(available[block] ? clip(values[f]) : 0);
  }
  for (const block of OPTIONAL_BLOCKS) x.push(available[block] ? 0 : 1);
  return { x, names: FEATURE_NAMES, available, dailyVol: vol, date, raw: values };
}

/**
 * Columns that are constant across the sample carry no information and make the
 * design singular. Dropping them per asset is what lets one shared column order
 * serve an equity with no derivatives lane and a perp with a full one.
 */
export function usableColumns(rows, { minVariation = 1e-10 } = {}) {
  if (!rows.length) return [];
  const p = rows[0].length;
  const keep = [];
  for (let j = 0; j < p; j++) {
    if (j === 0) { keep.push(j); continue; } // the intercept is kept by definition
    const first = rows[0][j];
    if (rows.some(r => Math.abs(r[j] - first) > minVariation)) keep.push(j);
  }
  return keep;
}

/**
 * Drop columns that are EXACT linear combinations of earlier ones, by modified
 * Gram-Schmidt. This has to run before any variance-inflation pass, because a
 * perfectly dependent column makes every VIF auxiliary regression singular --
 * so VIF returns null for every column, nothing is pruned, and the main fit
 * dies as `singular-design` with no indication of which column caused it.
 *
 * Real case: BTC benchmarked against BTC. `market5` is then identically
 * `return5`, and `relative5` is identically zero. Both must go, and neither is
 * visible to VIF once they coexist.
 */
export function independentColumns(rows, columns, { tolerance = 1e-8 } = {}) {
  const basis = [];
  const kept = [];
  for (const column of columns) {
    let vector = rows.map(r => r[column]);
    const originalNorm = Math.hypot(...vector);
    if (!(originalNorm > 0)) continue; // an all-zero column carries nothing
    for (const b of basis) {
      const projection = vector.reduce((s, v, i) => s + v * b[i], 0);
      vector = vector.map((v, i) => v - projection * b[i]);
    }
    const residualNorm = Math.hypot(...vector);
    if (residualNorm / originalNorm < tolerance) continue; // already spanned
    basis.push(vector.map(v => v / residualNorm));
    kept.push(column);
  }
  return kept;
}

/**
 * Greedy collinearity pruning by variance inflation. Deterministic and blind to
 * the response: it may not consult y, or it becomes a selection step that needs
 * its own out-of-sample correction. Ties break on the fixed column order.
 */
export function pruneCollinear(rows, columns, { maxVif = 10, computeVif } = {}) {
  let kept = [...columns];
  for (let guard = 0; guard < columns.length; guard++) {
    if (kept.length <= 2) break;
    const design = rows.map(r => kept.map(j => r[j]));
    const names = kept.map(String);
    const vifs = computeVif(design, names);
    let worst = null;
    for (const [name, value] of Object.entries(vifs)) {
      if (value != null && value > maxVif && (!worst || value > worst.value)) worst = { name, value };
    }
    if (!worst) break;
    kept = kept.filter(j => String(j) !== worst.name);
  }
  return kept;
}
