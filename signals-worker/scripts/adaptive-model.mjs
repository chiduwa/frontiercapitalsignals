// Additive, deliberately separate challenger. No imports of live evidence or
// current fundamentals: both would leak the future into a historical anchor.
export const ADAPTIVE_VERSION = 'adaptive-ridge-v1';
export const FEATURE_NAMES = ['intercept', 'return1', 'return5', 'return20', 'trend', 'volume', 'market5', 'relative5', 'marketMissing'];
const DAY = 86400000;
const clip = (x, bound = 4) => Math.max(-bound, Math.min(bound, x));
const mean = xs => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
const dateMs = d => Date.parse(`${d}T00:00:00Z`);

export function validateBars(input, { assetClass = 'crypto', asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const dates = new Set();
  const rejected = { invalid: 0, duplicate: 0, incomplete: 0 };
  const bars = [];
  for (const b of [...input].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !Number.isFinite(dateMs(b.date))
      || new Date(dateMs(b.date)).toISOString().slice(0, 10) !== b.date
      || !Number.isFinite(b.close) || !(b.close > 0)) { rejected.invalid++; continue; }
    if (b.date >= asOf) { rejected.incomplete++; continue; }
    if (dates.has(b.date)) { rejected.duplicate++; continue; }
    dates.add(b.date);
    bars.push({ ...b });
  }
  const maxGap = assetClass === 'crypto' ? 1 : 4;
  const gaps = bars.slice(1).filter((b, i) => (dateMs(b.date) - dateMs(bars[i].date)) / DAY > maxGap).length;
  return { bars, quality: { ...rejected, gaps, observations: bars.length, newest: bars.at(-1)?.date ?? null } };
}

// Returns must span the SAME pair of dates. Intersecting end dates alone
// still correlates a three-day asset move with a one-day benchmark move.
export function alignedBenchmarkStats(bars, benchmark, lookback = 60) {
  if (!bars?.length || !benchmark?.length) return null;
  const bm = new Map(benchmark.map(b => [b.date, b.close]));
  const pairs = [];
  for (let i = Math.max(1, bars.length - lookback); i < bars.length; i++) {
    const a = bars[i - 1], b = bars[i];
    if (!(bm.get(a.date) > 0 && bm.get(b.date) > 0)) continue;
    pairs.push([b.close / a.close - 1, bm.get(b.date) / bm.get(a.date) - 1]);
  }
  if (pairs.length < 20) return null;
  const ma = mean(pairs.map(p => p[0])), mb = mean(pairs.map(p => p[1]));
  let aa = 0, bb = 0, ab = 0;
  for (const [a, b] of pairs) { aa += (a - ma) ** 2; bb += (b - mb) ** 2; ab += (a - ma) * (b - mb); }
  if (!(aa > 0 && bb > 0)) return null;
  return { correlation: ab / Math.sqrt(aa * bb), beta: ab / bb, observations: pairs.length,
    asOf: bars.at(-1).date };
}

export function featuresAt(bars, i, benchmarkByDate = new Map(), assetClass = 'crypto') {
  if (i < 60) return null;
  const window = bars.slice(i - 60, i + 1);
  const maxGap = assetClass === 'crypto' ? 1 : 4;
  if (window.some((b, j) => j && (dateMs(b.date) - dateMs(window[j - 1].date)) / DAY > maxGap)) return null;
  const rets = window.slice(1).map((b, j) => Math.log(b.close / window[j].close));
  const avg = mean(rets);
  const vol = Math.sqrt(mean(rets.map(v => (v - avg) ** 2)));
  if (!(vol > 1e-6)) return null;
  const price = bars[i].close;
  const ret = n => Math.log(price / bars[i - n].close) / (vol * Math.sqrt(n));
  const volumes = window.slice(-20).map(b => b.volume).filter(v => Number.isFinite(v) && v > 0);
  const volumeAvailable = volumes.length >= 15 && Number.isFinite(bars[i].volume) && bars[i].volume > 0;
  const volume = volumeAvailable ? Math.log(bars[i].volume / mean(volumes)) : 0;
  const mb = benchmarkByDate.get(bars[i - 5].date), me = benchmarkByDate.get(bars[i].date);
  const market5 = mb > 0 && me > 0 ? Math.log(me / mb) / (vol * Math.sqrt(5)) : null;
  const trend = Math.log(price / mean(window.slice(-20).map(b => b.close))) / (vol * Math.sqrt(20));
  return { x: [1, ...[ret(1), ret(5), ret(20), trend, volume, market5 ?? 0,
    market5 == null ? 0 : ret(5) - market5].map(v => clip(v)), market5 == null ? 1 : 0],
  dailyVol: vol, volumeAvailable, marketAvailable: market5 != null };
}

function solve(a, b, ridge) {
  const n = b.length;
  const m = a.map((row, i) => row.map((v, j) => v + (i === j ? ridge : 0)).concat(b[i]));
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
    [m[k], m[pivot]] = [m[pivot], m[k]];
    if (Math.abs(m[k][k]) < 1e-12) return Array(n).fill(0);
    const d = m[k][k];
    for (let j = k; j <= n; j++) m[k][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = m[i][k];
      for (let j = k; j <= n; j++) m[i][j] -= f * m[k][j];
    }
  }
  return m.map(row => row[n]);
}

export function createAdaptiveRegressor({ halfLifeDays = 180, ridge = 20 } = {}) {
  if (!(halfLifeDays > 0 && ridge > 0)) throw new Error('Positive half-life and ridge required');
  const p = FEATURE_NAMES.length;
  const a = Array.from({ length: p }, () => Array(p).fill(0)), b = Array(p).fill(0);
  let count = 0, lastDate = null, weight = 0;
  return {
    update(x, y, observedDate) {
      if (x.length !== p || !x.every(Number.isFinite) || !Number.isFinite(y)) throw new Error('Invalid training example');
      if (lastDate && observedDate < lastDate) throw new Error('Training observations must be chronological');
      const elapsed = lastDate ? (dateMs(observedDate) - dateMs(lastDate)) / DAY : 0;
      const decay = Math.exp(-Math.LN2 * elapsed / halfLifeDays);
      const target = clip(y, 8); // robustness for fitting only; scoring is never clipped
      for (let i = 0; i < p; i++) {
        b[i] = b[i] * decay + x[i] * target;
        for (let j = 0; j < p; j++) a[i][j] = a[i][j] * decay + x[i] * x[j];
      }
      weight = weight * decay + 1;
      count++;
      lastDate = observedDate;
    },
    predict(x) {
      const coefficients = solve(a, b, ridge);
      return { value: clip(coefficients.reduce((s, w, i) => s + w * x[i], 0), 4),
        coefficients, trainingSamples: count, effectiveWeight: weight, trainedThrough: lastDate };
    }
  };
}

function intervalRadius(residuals, coverage) {
  if (residuals.length < 30) return null;
  const sorted = residuals.slice(-180).map(r => Math.abs(r)).sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length + 1) * coverage);
  return rank <= sorted.length ? sorted[rank - 1] : null;
}

// Prequential means: predict, wait for the target, score, then learn. We skip
// training windows that overlap, and use outcomes strictly BEFORE the next
// decision. This is also used to reconstruct state on a retry, deterministically.
export function walkForwardAsset(input, { symbol, assetClass = 'crypto', horizon = 1,
  benchmark = [], asOf = new Date().toISOString().slice(0, 10), costBps = 20,
  coverage = 0.8, halfLifeDays = 180, ridge = 20 } = {}) {
  if (![1, 5, 7].includes(horizon) || !(costBps >= 0 && Number.isFinite(costBps))
    || !(coverage > 0 && coverage < 1)) throw new Error('Invalid forecast configuration');
  const { bars, quality } = validateBars(input, { assetClass, asOf });
  const bench = validateBars(benchmark, { assetClass, asOf }).bars;
  const bm = new Map(bench.map(b => [b.date, b.close]));
  const model = createAdaptiveRegressor({ halfLifeDays, ridge });
  const pending = [], residuals = [], outcomes = [];
  let nextTrainIndex = 60, latest = null;
  for (let i = 60; i < bars.length; i++) {
    while (pending.length && pending[0].targetIndex < i) {
      const f = pending.shift(), exit = bars[f.targetIndex];
      const path = bars.slice(f.index, f.targetIndex + 1);
      const maxGap = assetClass === 'crypto' ? 1 : 4;
      if (path.some((bar, j) => j && (dateMs(bar.date) - dateMs(path[j - 1].date)) / DAY > maxGap)) continue;
      const actual = Math.log(exit.close / f.referencePrice);
      const actualPct = Math.expm1(actual) * 100;
      if (f.independent) {
        model.update(f.x, actual / f.scale, exit.date);
        if (f.trainingSamples >= 30) residuals.push((actual - f.expectedLogReturn) / f.scale);
        if (f.trainingSamples >= 30) outcomes.push({
          asOf: f.asOf, targetDate: exit.date, predictedPct: f.expectedReturnPct, actualPct,
          absoluteErrorPct: Math.abs(f.expectedReturnPct - actualPct),
          zeroErrorPct: Math.abs(actualPct),
          directionCorrect: Math.sign(f.expectedReturnPct) === Math.sign(actualPct),
          covered: f.interval ? actualPct >= f.interval.lowerPct && actualPct <= f.interval.upperPct : null,
          intervalWidthPct: f.interval ? f.interval.upperPct - f.interval.lowerPct : null,
          side: Math.abs(f.expectedReturnPct) > costBps / 100 ? Math.sign(f.expectedReturnPct) : 0,
          netReturnPct: Math.abs(f.expectedReturnPct) > costBps / 100
            ? Math.sign(f.expectedReturnPct) * actualPct - costBps / 100 : 0,
          buyHoldPct: actualPct, costBps, provenance: 'replay'
        });
      }
    }
    const features = featuresAt(bars, i, bm, assetClass);
    if (!features) continue;
    const pred = model.predict(features.x), scale = features.dailyVol * Math.sqrt(horizon);
    const expectedLogReturn = pred.value * scale;
    const radius = intervalRadius(residuals, coverage);
    const independent = i >= nextTrainIndex;
    if (independent) nextTrainIndex = i + horizon;
    latest = {
      modelVersion: ADAPTIVE_VERSION, symbol, assetClass, asOf: bars[i].date,
      horizon, horizonUnit: assetClass === 'stock' ? 'trading-sessions' : 'calendar-days',
      referencePrice: bars[i].close, expectedReturnPct: Math.expm1(expectedLogReturn) * 100,
      interval: radius == null ? null : {
        lowerPct: Math.expm1(expectedLogReturn - radius * scale) * 100,
        upperPct: Math.expm1(expectedLogReturn + radius * scale) * 100,
        nominalCoverage: coverage, calibrationSamples: Math.min(residuals.length, 180),
        method: 'rolling-prequential-residuals'
      },
      trainingSamples: pred.trainingSamples, effectiveWeight: pred.effectiveWeight,
      trainedThrough: pred.trainedThrough,
      coefficients: Object.fromEntries(FEATURE_NAMES.map((name, j) => [name, pred.coefficients[j]])),
      inputs: { volumeAvailable: features.volumeAvailable, marketAvailable: features.marketAvailable },
      status: pred.trainingSamples >= 30 && radius != null ? 'shadow' : 'warming-up', actionable: false
    };
    if (independent) pending.push({ ...latest, expectedLogReturn, x: features.x, scale,
      independent, index: i, targetIndex: i + horizon });
  }
  // A stale or gapped series must not present its last usable historical row
  // as today's forecast. Keep its historical test results for diagnosis.
  const ageDays = latest ? (dateMs(asOf) - dateMs(latest.asOf)) / DAY : Infinity;
  const stale = !latest || latest.asOf !== bars.at(-1)?.date || ageDays > (assetClass === 'stock' ? 5 : 2);
  return { symbol, assetClass, horizon, modelVersion: ADAPTIVE_VERSION,
    config: { costBps, coverage, halfLifeDays, ridge }, quality: { ...quality, ageDays: Number.isFinite(ageDays) ? ageDays : null, stale },
    benchmark: alignedBenchmarkStats(bars, bench), forecast: stale ? null : latest,
    metrics: summarizeOutcomes(outcomes), recentMetrics: summarizeOutcomes(outcomes.slice(-60)), outcomes };
}

export function summarizeOutcomes(rows) {
  const bands = rows.filter(r => r.covered != null), trades = rows.filter(r => r.side);
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const r of rows) {
    equity *= Math.max(0, 1 + r.netReturnPct / 100);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
  }
  const midpoint = Math.floor(rows.length / 2);
  return { observations: rows.length, directionalAccuracy: mean(rows.map(r => Number(r.directionCorrect))),
    meanAbsoluteErrorPct: mean(rows.map(r => r.absoluteErrorPct)),
    zeroForecastErrorPct: mean(rows.map(r => r.zeroErrorPct)),
    intervalObservations: bands.length, intervalCoverage: mean(bands.map(r => Number(r.covered))),
    meanIntervalWidthPct: mean(bands.map(r => r.intervalWidthPct)),
    trades: trades.length, meanNetReturnPct: mean(rows.map(r => r.netReturnPct)),
    meanTradeNetPct: mean(trades.map(r => r.netReturnPct)), maxDrawdownPct: maxDrawdown * 100,
    earlyNetPct: mean(rows.slice(0, midpoint).map(r => r.netReturnPct)),
    lateNetPct: mean(rows.slice(midpoint).map(r => r.netReturnPct)),
    meanBuyHoldPct: mean(rows.map(r => r.buyHoldPct)) };
}
