// One-time-ish research pass: pooled, guarded hypothesis tests against
// data already archived in asset_daily_bars — zero new data collection,
// pure analysis. See worker.js's twoSampleZTest/volumeSurgeSeries/
// forwardReturns/chronologicalHalfSplit for the shared building blocks.
//
// Pooled across the universe by asset class, never per-symbol: mining
// dozens of individual symbols for a correlation is exactly the
// multiple-testing trap isReliabilitySignificant's own docs (worker.js)
// warn about — with enough symbols tested independently, SOMETHING will
// clear a significance bar by chance alone. A candidate additionally has
// to independently clear the same bar in BOTH chronological halves of
// history (chronologicalHalfSplit) before it's recorded as a validated
// finding — the pooled-whole result alone isn't enough. An empty result
// (nothing survives both guardrails) is a complete, valid research
// outcome, logged in full either way — the log output here is as much
// the deliverable as the D1 rows.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
import { twoSampleZTest, volumeSurgeSeries, forwardReturns, chronologicalHalfSplit, RELIABILITY_SIGNIFICANCE_Z } from '../worker.js';
import { d1 } from './d1-client.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

const HORIZONS_DAYS = [1, 5];
const SURGE_THRESHOLD = 2.0; // at least double the trailing 20-day baseline volume
const VOLUME_LOOKBACK_DAYS = 20;
const MIN_SAMPLE_PER_BUCKET = 30; // a sanity floor distinct from the z-test's own sample-size handling — just "don't bother testing on a handful of points"
const MIN_MARKET_SURGE_SAMPLE = 10; // market-wide (summed-universe) surges are rarer, more extreme events than any single symbol's own — a lower floor for that bucket specifically

// Runs the pooled test, and only if it clears the bar, the chronological
// half-split re-check — returns a finding object only when BOTH
// guardrails pass, logging the full methodology either way.
function runGuardedTest(hypothesis, assetClass, horizonDays, surgeSample, normalSample) {
  const surgeValues = surgeSample.map((p) => p.value);
  const normalValues = normalSample.map((p) => p.value);
  const pooledResult = twoSampleZTest(surgeValues, normalValues);
  console.log(`[${hypothesis}] pooled: n=${pooledResult.n}, meanSurge=${pooledResult.meanA?.toFixed(3)}, meanNormal=${pooledResult.meanB?.toFixed(3)}, z=${pooledResult.z?.toFixed(3) ?? 'n/a'}`);
  if (pooledResult.z == null || Math.abs(pooledResult.z) < RELIABILITY_SIGNIFICANCE_Z) {
    console.log(`[${hypothesis}] does not clear the pooled significance bar — no finding`);
    return null;
  }

  const allDates = [...surgeSample.map((p) => p.date), ...normalSample.map((p) => p.date)];
  const { firstHalf, secondHalf } = chronologicalHalfSplit(allDates);
  const firstResult = twoSampleZTest(
    surgeSample.filter((p) => firstHalf.has(p.date)).map((p) => p.value),
    normalSample.filter((p) => firstHalf.has(p.date)).map((p) => p.value)
  );
  const secondResult = twoSampleZTest(
    surgeSample.filter((p) => secondHalf.has(p.date)).map((p) => p.value),
    normalSample.filter((p) => secondHalf.has(p.date)).map((p) => p.value)
  );
  console.log(`[${hypothesis}] first half: n=${firstResult.n}, z=${firstResult.z?.toFixed(3) ?? 'n/a'} — second half: n=${secondResult.n}, z=${secondResult.z?.toFixed(3) ?? 'n/a'}`);

  const firstOk = firstResult.z != null && Math.abs(firstResult.z) >= RELIABILITY_SIGNIFICANCE_Z;
  const secondOk = secondResult.z != null && Math.abs(secondResult.z) >= RELIABILITY_SIGNIFICANCE_Z;
  const sameSign = firstResult.effectSize != null && secondResult.effectSize != null && Math.sign(firstResult.effectSize) === Math.sign(secondResult.effectSize);
  if (!firstOk || !secondOk || !sameSign) {
    console.log(`[${hypothesis}] cleared the pooled bar but did NOT hold up independently, same-signed, in both chronological halves — not recorded as a validated finding`);
    return null;
  }

  console.log(`[${hypothesis}] VALIDATED — holds up independently in both halves of history`);
  return {
    hypothesis, assetClass, horizonDays, n: pooledResult.n, effectSize: pooledResult.effectSize, z: pooledResult.z,
    notes: `pooled z=${pooledResult.z.toFixed(3)}; first-half z=${firstResult.z.toFixed(3)}, n=${firstResult.n}; second-half z=${secondResult.z.toFixed(3)}, n=${secondResult.n}`
  };
}

async function main() {
  const nowIso = new Date().toISOString();
  console.log('correlation-research starting: volume-surge vs forward-return, pooled by asset class, guarded against multiple-testing');

  const rows = await d1(env, 'SELECT symbol, asset_class, date, close, volume FROM asset_daily_bars ORDER BY symbol, date');
  const bySymbol = {};
  for (const r of rows) {
    (bySymbol[r.symbol] ??= { assetClass: r.asset_class, bars: [] }).bars.push({ date: r.date, close: r.close, volume: r.volume });
  }
  console.log(`loaded ${rows.length} rows across ${Object.keys(bySymbol).length} symbols`);

  // { date, value } pairs (not bare numbers) so the half-split re-check
  // can later partition by date.
  const pooled = {
    crypto: Object.fromEntries(HORIZONS_DAYS.map((h) => [h, { surge: [], normal: [] }])),
    stock: Object.fromEntries(HORIZONS_DAYS.map((h) => [h, { surge: [], normal: [] }]))
  };
  const cryptoDailyVolume = {}; // date -> summed crypto volume that day (for the market-wide test below)
  const cryptoDailyReturns = Object.fromEntries(HORIZONS_DAYS.map((h) => [h, {}])); // date -> [forward returns across every crypto symbol]

  for (const [, { assetClass, bars }] of Object.entries(bySymbol)) {
    if (assetClass !== 'crypto' && assetClass !== 'stock') continue; // benchmarks/pseudo-symbols (SECTOR:*, SPREAD:*, TVL:*) don't have a real per-asset volume story
    if (bars.length < VOLUME_LOOKBACK_DAYS + 30) continue; // not enough real history to say anything
    const surgeByDate = Object.fromEntries(volumeSurgeSeries(bars, VOLUME_LOOKBACK_DAYS).map((s) => [s.date, s.surgeRatio]));
    const fwd = forwardReturns(bars, HORIZONS_DAYS);

    for (const bar of bars) {
      if (assetClass === 'crypto' && bar.volume != null) cryptoDailyVolume[bar.date] = (cryptoDailyVolume[bar.date] || 0) + bar.volume;
      const entry = fwd[bar.date];
      if (!entry) continue;
      if (assetClass === 'crypto') {
        for (const h of HORIZONS_DAYS) {
          if (entry[h] == null) continue;
          (cryptoDailyReturns[h][bar.date] ??= []).push(entry[h]);
        }
      }
      const ratio = surgeByDate[bar.date];
      if (ratio == null) continue; // not enough trailing history yet for this symbol/date
      const bucket = ratio >= SURGE_THRESHOLD ? 'surge' : 'normal';
      for (const h of HORIZONS_DAYS) {
        if (entry[h] == null) continue;
        pooled[assetClass][h][bucket].push({ date: bar.date, value: entry[h] });
      }
    }
  }

  const findings = [];

  // 4 primary tests: per-symbol volume surge vs forward return, pooled by
  // asset class x horizon.
  for (const assetClass of ['crypto', 'stock']) {
    for (const h of HORIZONS_DAYS) {
      const { surge, normal } = pooled[assetClass][h];
      const hypothesis = `volume_surge_${assetClass}_${h}d`;
      if (surge.length < MIN_SAMPLE_PER_BUCKET || normal.length < MIN_SAMPLE_PER_BUCKET) {
        console.log(`[${hypothesis}] too few samples (surge=${surge.length}, normal=${normal.length}) — skipped`);
        continue;
      }
      const finding = runGuardedTest(hypothesis, assetClass, h, surge, normal);
      if (finding) findings.push(finding);
    }
  }

  // Market-wide: volumeSurgeSeries over the SUMMED crypto daily volume,
  // tested against that day's cross-sectional average crypto forward
  // return — "does the whole market's volume say anything," not just one
  // asset's own.
  const marketBars = Object.entries(cryptoDailyVolume).map(([date, volume]) => ({ date, volume }));
  const marketSurges = volumeSurgeSeries(marketBars, VOLUME_LOOKBACK_DAYS);
  for (const h of HORIZONS_DAYS) {
    const surgeSample = [], normalSample = [];
    for (const s of marketSurges) {
      const returns = cryptoDailyReturns[h][s.date];
      if (!returns || !returns.length) continue;
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      (s.surgeRatio >= SURGE_THRESHOLD ? surgeSample : normalSample).push({ date: s.date, value: avgReturn });
    }
    const hypothesis = `volume_surge_market_${h}d`;
    if (surgeSample.length < MIN_MARKET_SURGE_SAMPLE || normalSample.length < MIN_SAMPLE_PER_BUCKET) {
      console.log(`[${hypothesis}] too few samples (surge=${surgeSample.length}, normal=${normalSample.length}) — skipped`);
      continue;
    }
    const finding = runGuardedTest(hypothesis, 'crypto', h, surgeSample, normalSample);
    if (finding) findings.push(finding);
  }

  console.log(`correlation-research: ${findings.length} validated finding(s)`);
  for (const f of findings) {
    await d1(env, `
      INSERT INTO correlation_research_findings (hypothesis, asset_class, horizon_days, n, effect_size, z, split_consistent, computed_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [f.hypothesis, f.assetClass, f.horizonDays, f.n, f.effectSize, f.z, 1, nowIso, f.notes]);
  }
  console.log(findings.length ? 'findings written to correlation_research_findings' : 'no findings cleared both guardrails — nothing written (a complete, valid research outcome)');
}

main().catch((e) => { console.error('correlation-research failed:', e); process.exit(1); });
