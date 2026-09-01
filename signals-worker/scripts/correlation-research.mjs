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
import { twoSampleZTest, volumeSurgeSeries, forwardReturns, chronologicalHalfSplit, sentimentExtremeForwardReturns, timeOfDaySentimentSplit, RELIABILITY_SIGNIFICANCE_Z, detectMoveEpisodes, detectExhaustionReversals, detectBottomThenMoonshot, volRegime, levelChangeBefore, isNonDirectionalAsset, pegAnchorDeviationPct } from '../worker.js';
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
// Bonferroni-corrected significance bar for the compound time-of-day x
// sentiment family below, which deliberately tests a SET of slots (not
// one) and would otherwise inherit the same multiple-testing risk this
// whole module exists to guard against. Family size 4 (hour_et_00 plus
// hour_utc_00/08/16), overall alpha 0.01 to match RELIABILITY_SIGNIFICANCE_Z's
// own two-tailed 0.01 -> per-test alpha 0.0025 -> z = NormalDist().inv_cdf(1 - 0.00125)
// = 3.0233 (computed once via Python's statistics module, not re-derived
// at runtime). Applies only to the initial pooled test across the family
// — the half-split follow-up re-check on a candidate that's already
// cleared this bar uses the standard RELIABILITY_SIGNIFICANCE_Z, since
// that's a single confirmatory check on one already-selected candidate,
// not another multiple-comparison scan.
const TOD_SENTIMENT_BONFERRONI_Z = 3.0233;
const TOD_SENTIMENT_SLOTS = ['hour_et_00', 'hour_utc_00', 'hour_utc_08', 'hour_utc_16'];
const TOD_SENTIMENT_HORIZON_HOURS = 4; // "after some hours," per the user's own framing — not the 1h slice

// Runs the pooled test, and only if it clears the bar, the chronological
// half-split re-check — returns a finding object only when BOTH
// guardrails pass, logging the full methodology either way. `pooledZBar`
// lets a caller apply a stricter (e.g. Bonferroni-corrected) bar to the
// pooled stage specifically, for a hypothesis family that scans several
// candidates at once — the half-split stage always uses the standard
// RELIABILITY_SIGNIFICANCE_Z, since it's a single confirmatory re-check
// on one already-selected candidate, not another multi-candidate scan.
function runGuardedTest(hypothesis, assetClass, horizonDays, surgeSample, normalSample, pooledZBar = RELIABILITY_SIGNIFICANCE_Z) {
  const surgeValues = surgeSample.map((p) => p.value);
  const normalValues = normalSample.map((p) => p.value);
  const pooledResult = twoSampleZTest(surgeValues, normalValues);
  console.log(`[${hypothesis}] pooled: n=${pooledResult.n}, meanSurge=${pooledResult.meanA?.toFixed(3)}, meanNormal=${pooledResult.meanB?.toFixed(3)}, z=${pooledResult.z?.toFixed(3) ?? 'n/a'} (bar=${pooledZBar})`);
  if (pooledResult.z == null || Math.abs(pooledResult.z) < pooledZBar) {
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
  const stablecoinDeviationByDate = {}; // date -> largest observed deviation from the $1 peg

  for (const [symbol, { assetClass, bars }] of Object.entries(bySymbol)) {
    if (assetClass !== 'crypto' && assetClass !== 'stock') continue; // benchmarks/pseudo-symbols (SECTOR:*, SPREAD:*, TVL:*) don't have a real per-asset volume story
    if (bars.length < VOLUME_LOOKBACK_DAYS + 30) continue; // not enough real history to say anything
    // Behavioural test, not the name list. Two things were wrong here and
    // they pulled in opposite directions.
    //
    // First, an unknown peg — which USDG was for months — failed the name
    // check and was therefore counted as an ordinary MARKET asset, quietly
    // contaminating the cross-sectional return series that this very test
    // uses as its baseline.
    //
    // Second, and introduced by widening the blocklist on 2026-08-31: the
    // deviation below assumed a $1 anchor. That was survivable while the
    // list held only dollar stablecoins, but it now also holds tokenized
    // T-bill funds trading near $11 (USTB) and $106 (BCAP), for which
    // |close - 1| computes a ~10,525% "depeg" on every single bar. That
    // would have dominated the daily maximum outright and pushed every
    // date over the 0.25% stress threshold, leaving the normal-day bucket
    // empty and silently killing the test rather than producing a visibly
    // wrong answer. Anchor to the asset's own median instead — see
    // pegAnchorDeviationPct.
    const closes = bars.map((b) => Number(b.close)).filter((v) => Number.isFinite(v) && v > 0);
    const stable = assetClass === 'crypto' && isNonDirectionalAsset({ symbol }, closes);
    if (stable) {
      for (const bar of bars) {
        if (bar.close == null || !Number.isFinite(Number(bar.close))) continue;
        const deviation = pegAnchorDeviationPct(closes, Number(bar.close));
        if (deviation == null) continue;
        stablecoinDeviationByDate[bar.date] = Math.max(stablecoinDeviationByDate[bar.date] || 0, deviation);
      }
      continue; // stablecoins are the explanatory variable below, not market assets
    }
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

  // Research-only stablecoin stress test. A stablecoin leaving its peg is
  // compared with the next-day cross-sectional return of non-stable crypto.
  // It is deliberately not a live technique: archived coverage can be sparse,
  // and the same pooled + chronological-half guardrails must clear first.
  const stablecoinStressSample = [], stablecoinNormalSample = [];
  for (const [date, deviation] of Object.entries(stablecoinDeviationByDate)) {
    const returns = cryptoDailyReturns[1][date];
    if (!returns || !returns.length) continue;
    const marketReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    (deviation >= 0.25 ? stablecoinStressSample : stablecoinNormalSample).push({ date, value: marketReturn });
  }
  const stablecoinHypothesis = 'stablecoin_depeg_crypto_1d';
  if (stablecoinStressSample.length < MIN_SAMPLE_PER_BUCKET || stablecoinNormalSample.length < MIN_SAMPLE_PER_BUCKET) {
    console.log(`[${stablecoinHypothesis}] too few samples (stress=${stablecoinStressSample.length}, normal=${stablecoinNormalSample.length}) — skipped`);
  } else {
    const finding = runGuardedTest(stablecoinHypothesis, 'crypto', 1, stablecoinStressSample, stablecoinNormalSample);
    if (finding) findings.push(finding);
  }

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

  // Sentiment-extreme forward returns: crypto only, matching the live
  // `sentiment` technique's own scoping — evaluateTechniques gates
  // marketContext.fearGreed on kind === 'crypto' (alternative.me's Fear &
  // Greed Index is itself a crypto-market gauge, not a general-market
  // one, so a stock-side version of this hypothesis wouldn't mean
  // anything). Same >=75/<=25 extreme thresholds the live technique uses.
  const sentimentRows = await d1(env, "SELECT date, fear_greed_altme FROM sentiment_daily WHERE symbol = '' AND fear_greed_altme IS NOT NULL");
  const sentimentByDate = Object.fromEntries(sentimentRows.map((r) => [r.date, r.fear_greed_altme]));
  console.log(`loaded ${sentimentRows.length} days of Fear & Greed history`);

  const sentimentPooled = Object.fromEntries(HORIZONS_DAYS.map((h) => [h, { low: [], high: [], normal: [] }]));
  for (const [, { assetClass, bars }] of Object.entries(bySymbol)) {
    if (assetClass !== 'crypto' || bars.length < 30) continue;
    const buckets = sentimentExtremeForwardReturns(bars, sentimentByDate, HORIZONS_DAYS);
    for (const h of HORIZONS_DAYS) {
      sentimentPooled[h].low.push(...buckets[h].low);
      sentimentPooled[h].high.push(...buckets[h].high);
      sentimentPooled[h].normal.push(...buckets[h].normal);
    }
  }
  for (const h of HORIZONS_DAYS) {
    const { low, high, normal } = sentimentPooled[h];
    for (const [label, sample] of [['low', low], ['high', high]]) {
      const hypothesis = `sentiment_extreme_${label}_${h}d`;
      if (sample.length < MIN_SAMPLE_PER_BUCKET || normal.length < MIN_SAMPLE_PER_BUCKET) {
        console.log(`[${hypothesis}] too few samples (extreme=${sample.length}, normal=${normal.length}) — skipped`);
        continue;
      }
      const finding = runGuardedTest(hypothesis, 'crypto', h, sample, normal);
      if (finding) findings.push(finding);
    }
  }

  // Compound: does a SPECIFIC clock slot's forward-return behavior differ
  // between sentiment-extreme and sentiment-normal days — the question
  // behind the user's own "00:00 EST" example. Restricted to a small
  // named set of slots (not all ~50 possible) with a Bonferroni-corrected
  // pooled bar — see TOD_SENTIMENT_BONFERRONI_Z's own docs. Uses the raw
  // Binance-sourced asset_hourly_bars from Phase 2, not the pre-aggregated
  // time_of_day_stats (a running sum that can't be retroactively split by
  // sentiment regime).
  const hourlyRows = await d1(env, 'SELECT symbol, bar_at AS ts, close FROM asset_hourly_bars ORDER BY symbol, bar_at');
  const hourlyBySymbol = {};
  for (const r of hourlyRows) (hourlyBySymbol[r.symbol] ??= []).push({ ts: r.ts, close: r.close });
  console.log(`loaded ${hourlyRows.length} hourly bars across ${Object.keys(hourlyBySymbol).length} crypto symbols for the compound time-of-day x sentiment pass`);

  for (const slot of TOD_SENTIMENT_SLOTS) {
    const extreme = [], normal = [];
    for (const bars of Object.values(hourlyBySymbol)) {
      const split = timeOfDaySentimentSplit(bars, sentimentByDate, slot, TOD_SENTIMENT_HORIZON_HOURS);
      extreme.push(...split.extreme);
      normal.push(...split.normal);
    }
    const hypothesis = `tod_x_sentiment_${slot}`;
    if (extreme.length < MIN_SAMPLE_PER_BUCKET || normal.length < MIN_SAMPLE_PER_BUCKET) {
      console.log(`[${hypothesis}] too few samples (extreme=${extreme.length}, normal=${normal.length}) — skipped`);
      continue;
    }
    const finding = runGuardedTest(hypothesis, 'crypto', null, extreme, normal, TOD_SENTIMENT_BONFERRONI_Z);
    if (finding) {
      finding.notes += ` (horizon=${TOD_SENTIMENT_HORIZON_HOURS}h, Bonferroni pooled bar=${TOD_SENTIMENT_BONFERRONI_Z})`;
      findings.push(finding);
    }
  }

  // ---- Consolidation-then-breakout research (2026-08-21) --------------------
  // Detects every historical episode where a tracked asset moved
  // >=EPISODE_THRESHOLD_PCT% within EPISODE_WINDOW_DAYS days, either
  // direction (detectMoveEpisodes, worker.js), then tests two candidate
  // leading covariates with the exact same pooled + chronological-half-
  // split guardrail as every hypothesis above. Descriptive stats (typical
  // magnitude/duration by side) are logged unconditionally — "how far do
  // these usually go" is a real statistic once real episodes exist, not a
  // hypothesis with a null to reject.
  const EPISODE_THRESHOLD_PCT = 20;
  const EPISODE_WINDOW_DAYS = 7;
  const EPISODE_COOLDOWN_DAYS = 21;
  const YIELD_LOOKBACK_DAYS = [3, 5, 10];
  // Lower than MIN_SAMPLE_PER_BUCKET (30) for the same reason
  // MIN_MARKET_SURGE_SAMPLE is lower than it above: a >=20%-in-a-week move
  // is a rare, significant event by construction — there will never be as
  // many of these as ordinary trading days, no matter how deep the archive
  // gets. If real data can't even clear 15, that's the honest answer, not
  // a reason to lower the bar further just to force a result.
  const MIN_EPISODE_SAMPLE = 15;
  // "Extended run" precondition for the exhaustion-reversal research below:
  // at least this much cumulative move in the OPPOSITE direction over the
  // preceding window, real but not itself abrupt (kept well under
  // EPISODE_THRESHOLD_PCT so a genuine multi-day rally/decline doesn't just
  // get counted as its own episode instead of the setup for this one).
  const EXHAUSTION_PRIOR_RUN_LOOKBACK_DAYS = 10;
  const EXHAUSTION_PRIOR_RUN_THRESHOLD_PCT = 12;
  const EXHAUSTION_RECLAIM_WINDOW_DAYS = 30;

  const allEpisodes = [];
  const allExhaustionReversals = [];
  for (const [symbol, { assetClass, bars }] of Object.entries(bySymbol)) {
    if (assetClass !== 'crypto' && assetClass !== 'stock') continue;
    if (bars.length < 90) continue;
    const sortedBars = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const symbolEpisodes = [];
    for (const e of detectMoveEpisodes(sortedBars, EPISODE_THRESHOLD_PCT, EPISODE_WINDOW_DAYS, EPISODE_COOLDOWN_DAYS)) {
      const compression = volRegime(sortedBars.slice(0, e.startIdx + 1).map((b) => b.close), 20, 60);
      const decorated = { symbol, assetClass, ...e, compression };
      symbolEpisodes.push(decorated);
      allEpisodes.push(decorated);
    }
    for (const r of detectExhaustionReversals(sortedBars, symbolEpisodes, EXHAUSTION_PRIOR_RUN_LOOKBACK_DAYS, EXHAUSTION_PRIOR_RUN_THRESHOLD_PCT, EXHAUSTION_RECLAIM_WINDOW_DAYS)) {
      allExhaustionReversals.push(r);
    }
  }
  console.log(`consolidation research: ${allEpisodes.length} episodes found (>=${EPISODE_THRESHOLD_PCT}% within <=${EPISODE_WINDOW_DAYS} days) across ${Object.keys(bySymbol).length} symbols`);

  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  for (const cls of ['crypto', 'stock']) {
    for (const dir of [1, -1]) {
      const subset = allEpisodes.filter((e) => e.assetClass === cls && e.dir === dir);
      if (!subset.length) { console.log(`[episode stats] ${cls} ${dir === 1 ? 'bullish' : 'bearish'}: none found`); continue; }
      const comps = subset.filter((e) => e.compression != null).map((e) => e.compression);
      console.log(`[episode stats] ${cls} ${dir === 1 ? 'bullish' : 'bearish'}: n=${subset.length}, median full move=${median(subset.map((e) => e.fullMovePct))?.toFixed(1)}%, median days-to-extreme=${median(subset.map((e) => e.daysToExtreme))}, mean pre-episode compression ratio=${mean(comps)?.toFixed(2) ?? 'n/a'} (< 1.0 means genuinely coiled going in)`);
    }
  }

  // Yield moves preceding a crypto episode — the user's own "yield rate
  // dropping" framing, tested both directions: does a yield DROP precede a
  // BULLISH episode, does a yield RISE precede a BEARISH one. Normal
  // sample: the same level-change-over-N-days metric at a regular sample
  // of ordinary days (every 5th, not literally every day — a stable
  // baseline mean doesn't need the full density, and it keeps this fast).
  const yieldSeries = {};
  for (const sym of ['UST10Y', 'UST2Y', 'SPREAD:2s10s']) {
    yieldSeries[sym] = ((bySymbol[sym] && bySymbol[sym].bars) || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  const allDates = [...new Set(rows.map((r) => r.date))].sort().filter((_, i) => i % 5 === 0);

  for (const sym of ['UST10Y', 'UST2Y', 'SPREAD:2s10s']) {
    if (!yieldSeries[sym].length) { console.log(`[yield research] ${sym}: not archived, skipped`); continue; }
    for (const lookback of YIELD_LOOKBACK_DAYS) {
      const normalSample = allDates
        .map((d) => ({ date: d, value: levelChangeBefore(yieldSeries[sym], d, lookback) }))
        .filter((p) => p.value != null);
      for (const [label, dir] of [['bull', 1], ['bear', -1]]) {
        const episodeSample = allEpisodes
          .filter((e) => e.assetClass === 'crypto' && e.dir === dir)
          .map((e) => ({ date: e.startDate, value: levelChangeBefore(yieldSeries[sym], e.startDate, lookback) }))
          .filter((p) => p.value != null);
        const hypothesis = `yield_${sym.replace(/[:.]/g, '_')}_before_${label}_crypto_episode_${lookback}d`;
        if (episodeSample.length < MIN_EPISODE_SAMPLE || normalSample.length < MIN_SAMPLE_PER_BUCKET) {
          console.log(`[${hypothesis}] too few samples (episode=${episodeSample.length}, normal=${normalSample.length}) — skipped`);
          continue;
        }
        const finding = runGuardedTest(hypothesis, 'crypto', null, episodeSample, normalSample);
        if (finding) findings.push(finding);
      }
    }
  }

  // Pre-episode volatility compression — was the asset genuinely coiled
  // (volRegime < 1) going into the move, pooled across both directions
  // (coiling should precede a breakout either way, unlike the yield
  // hypothesis above which is directionally specific). Normal sample:
  // volRegime computed at a regular sample of points per symbol (every
  // 15th bar), not just episode starts.
  const compressionEpisodeSample = allEpisodes
    .filter((e) => e.assetClass === 'crypto' && e.compression != null)
    .map((e) => ({ date: e.startDate, value: e.compression }));
  const compressionNormalSample = [];
  for (const [symbol, { assetClass, bars }] of Object.entries(bySymbol)) {
    if (assetClass !== 'crypto' || bars.length < 90) continue;
    const sortedBars = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 60; i < sortedBars.length; i += 15) {
      const v = volRegime(sortedBars.slice(0, i + 1).map((b) => b.close), 20, 60);
      if (v != null) compressionNormalSample.push({ date: sortedBars[i].date, value: v });
    }
  }
  const compressionHypothesis = 'pre_episode_compression_crypto';
  if (compressionEpisodeSample.length < MIN_EPISODE_SAMPLE || compressionNormalSample.length < MIN_SAMPLE_PER_BUCKET) {
    console.log(`[${compressionHypothesis}] too few samples (episode=${compressionEpisodeSample.length}, normal=${compressionNormalSample.length}) — skipped`);
  } else {
    const finding = runGuardedTest(compressionHypothesis, 'crypto', null, compressionEpisodeSample, compressionNormalSample);
    if (finding) findings.push(finding);
  }

  // Exhaustion reversals: a sudden dip/spike preceded by an extended run in
  // the OPPOSITE direction — "dipped suddenly after days of continuous
  // rising" (user-requested 2026-08-22, grounded in the real event that
  // day: BTC/ETH/SOL/XRP/XLM/HBAR all hit fresh highs then pulled back
  // 3-11% intraday after the 08-20/21 rally, still net-positive for the
  // day). The prevalence/outcome split is reported unconditionally, same
  // philosophy as the episode stats above — "how often is this an outlier
  // vs a genuine pivot" is a real statistic once real cases exist, not a
  // hypothesis with a null to reject. Two guarded hypotheses follow the
  // user's own candidate explanations: does volume at the reversal predict
  // which outcome, and does it matter whether the WHOLE market was also
  // extended at the time (vs this being an isolated single-asset move).
  console.log(`\nexhaustion-reversal research: ${allExhaustionReversals.length} episodes found — a >=${EPISODE_THRESHOLD_PCT}% move preceded by a >=${EXHAUSTION_PRIOR_RUN_THRESHOLD_PCT}% run the OTHER way over the prior ${EXHAUSTION_PRIOR_RUN_LOOKBACK_DAYS} days`);
  for (const dir of [-1, 1]) {
    const subset = allExhaustionReversals.filter((e) => e.assetClass === 'crypto' && e.dir === dir);
    const label = dir === -1 ? 'bull-exhaustion (dip after a rally)' : 'bear-exhaustion (spike after a decline — capitulation bounce)';
    if (!subset.length) { console.log(`[exhaustion stats] crypto ${label}: none found`); continue; }
    const reclaimed = subset.filter((e) => e.outcome === 'reclaimed');
    const held = subset.filter((e) => e.outcome === 'held');
    console.log(`[exhaustion stats] crypto ${label}: n=${subset.length}, median prior run=${median(subset.map((e) => e.priorRunPct))?.toFixed(1)}%, median move=${median(subset.map((e) => e.fullMovePct))?.toFixed(1)}%, median days-to-extreme=${median(subset.map((e) => e.daysToExtreme))}`);
    console.log(`[exhaustion stats] crypto ${label}: OUTCOME — reclaimed/outlier: ${reclaimed.length} (${((reclaimed.length / subset.length) * 100).toFixed(0)}%, median ${median(reclaimed.map((e) => e.daysToReclaim))} days to reclaim) | held/genuine pivot: ${held.length} (${((held.length / subset.length) * 100).toFixed(0)}%)`);
  }

  const MIN_EXHAUSTION_SAMPLE = 10; // rarer than a plain episode (episode AND a qualifying prior run AND enough forward history to classify the outcome) — MIN_MARKET_SURGE_SAMPLE's same reasoning for a rarer bucket
  const exhaustionSurgeBySymbol = {};
  for (const r of allExhaustionReversals) {
    if (r.symbol in exhaustionSurgeBySymbol) continue;
    const symBars = (bySymbol[r.symbol] && bySymbol[r.symbol].bars) || [];
    exhaustionSurgeBySymbol[r.symbol] = Object.fromEntries(volumeSurgeSeries(symBars, VOLUME_LOOKBACK_DAYS).map((s) => [s.date, s.surgeRatio]));
  }
  const exhaustionVolumeReclaimed = allExhaustionReversals
    .filter((r) => r.assetClass === 'crypto' && r.outcome === 'reclaimed')
    .map((r) => ({ date: r.detectedDate, value: exhaustionSurgeBySymbol[r.symbol] && exhaustionSurgeBySymbol[r.symbol][r.detectedDate] }))
    .filter((p) => p.value != null);
  const exhaustionVolumeHeld = allExhaustionReversals
    .filter((r) => r.assetClass === 'crypto' && r.outcome === 'held')
    .map((r) => ({ date: r.detectedDate, value: exhaustionSurgeBySymbol[r.symbol] && exhaustionSurgeBySymbol[r.symbol][r.detectedDate] }))
    .filter((p) => p.value != null);
  const exhaustionVolumeHypothesis = 'exhaustion_reversal_volume_held_vs_reclaimed';
  if (exhaustionVolumeReclaimed.length < MIN_EXHAUSTION_SAMPLE || exhaustionVolumeHeld.length < MIN_EXHAUSTION_SAMPLE) {
    console.log(`[${exhaustionVolumeHypothesis}] too few samples (reclaimed=${exhaustionVolumeReclaimed.length}, held=${exhaustionVolumeHeld.length}) — skipped`);
  } else {
    const finding = runGuardedTest(exhaustionVolumeHypothesis, 'crypto', null, exhaustionVolumeHeld, exhaustionVolumeReclaimed);
    if (finding) findings.push(finding);
  }

  // Does it matter whether the whole market was ALSO extended in the same
  // direction at the time (a market-wide top/bottom), vs this being an
  // isolated single-asset move? Encodes outcome as held=1/reclaimed=0 and
  // compares the two groups' mean — equivalent to a two-proportion test,
  // reusing twoSampleZTest as-is rather than writing a new stats function.
  // Half the per-asset prior-run bar: a broad market-cap composite is
  // structurally less volatile than any single constituent (diversification
  // dampens it), so requiring the same bar as the individual asset would
  // almost never fire.
  const marketSymbolKey = (bySymbol['MCAP:TOTAL'] && bySymbol['MCAP:TOTAL'].bars.length > 90) ? 'MCAP:TOTAL' : (bySymbol['MCAP:BROAD'] ? 'MCAP:BROAD' : null);
  const marketLabel = marketSymbolKey === 'MCAP:BROAD' ? 'MCAP:BROAD (proxy)' : (marketSymbolKey || 'none');
  const marketSeries = (marketSymbolKey ? bySymbol[marketSymbolKey].bars : []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const pctRunBefore = (series, targetDate, lookbackDays) => {
    let idx = -1;
    for (let i = series.length - 1; i >= 0; i--) { if (series[i].date <= targetDate) { idx = i; break; } }
    if (idx < lookbackDays) return null;
    const now = series[idx].close, then = series[idx - lookbackDays].close;
    return (now == null || !then) ? null : ((now / then) - 1) * 100;
  };
  const marketAligned = [], isolated = [];
  for (const r of allExhaustionReversals) {
    if (r.assetClass !== 'crypto' || !marketSeries.length) continue;
    const marketRunPct = pctRunBefore(marketSeries, r.startDate, EXHAUSTION_PRIOR_RUN_LOOKBACK_DAYS);
    if (marketRunPct == null) continue;
    const marketAgrees = r.dir === -1 ? marketRunPct >= EXHAUSTION_PRIOR_RUN_THRESHOLD_PCT / 2 : marketRunPct <= -EXHAUSTION_PRIOR_RUN_THRESHOLD_PCT / 2;
    (marketAgrees ? marketAligned : isolated).push({ date: r.startDate, value: r.outcome === 'held' ? 1 : 0 });
  }
  console.log(`[exhaustion market-alignment] using ${marketLabel} as the market-wide series; aligned=${marketAligned.length}, isolated=${isolated.length}`);
  const marketAlignHypothesis = 'exhaustion_reversal_market_aligned_predicts_pivot';
  if (marketAligned.length < MIN_EXHAUSTION_SAMPLE || isolated.length < MIN_EXHAUSTION_SAMPLE) {
    console.log(`[${marketAlignHypothesis}] too few samples (aligned=${marketAligned.length}, isolated=${isolated.length}) — skipped`);
  } else {
    const finding = runGuardedTest(marketAlignHypothesis, 'crypto', null, marketAligned, isolated);
    if (finding) findings.push(finding);
  }

  // Leaders vs laggers (user-requested 2026-08-22, follow-up to the
  // exhaustion-reversal work above): does a specific asset's OWN reversal
  // tend to happen BEFORE others', making it an early warning rather than
  // just another coincident symptom of the same market-wide move? This is
  // deliberately scoped to two PRE-SPECIFIED, structurally-obvious
  // candidates — BTC (already the dominant benchmark used everywhere else
  // in this codebase, e.g. correlationWithBenchmark) and the market
  // composite itself — not a mined scan across every symbol pair. Testing
  // all ~50+ symbols as candidate leaders would be exactly the multiple-
  // testing trap this file's own header warns about: with enough symbols
  // tried, something clears significance by chance alone. (The general,
  // ongoing version of "which symbol leads which" already exists and runs
  // daily — see computeLeadLag/lead_lag_signals, archive.mjs — this is
  // narrower: does that leadership structure specifically hold AROUND
  // exhaustion-reversal events.)
  const exhaustionLeaderCandidates = ['BTC', ...(marketSymbolKey ? [marketSymbolKey] : [])];

  // Descriptive first (unconditional, same philosophy as the episode/
  // outcome stats above): of the OTHER assets' own qualifying exhaustion
  // reversals, when one falls within 15 days of this candidate's own
  // same-direction reversal, how many days apart are they and who moved
  // first — a plain, intuitive "does X tend to lead by about N days." Widened
  // beyond BTC/market for this DESCRIPTIVE pass only (never for the guarded
  // hypothesis test below, which stays limited to the two pre-specified
  // candidates) to the top general leaders already validated by the
  // existing, independent, already-rigorous lead_lag_signals table
  // (computeLeadLag, archive.mjs) — the candidate SET was chosen by that
  // separate process before this analysis ever ran, so checking them here
  // isn't a fresh post-hoc mining scan, just asking whether an
  // already-proven day-to-day leader ALSO leads specifically on this event.
  let generalLeaders = [];
  try {
    generalLeaders = await d1(env, 'SELECT leader_symbol, COUNT(*) as followers FROM lead_lag_signals GROUP BY leader_symbol ORDER BY followers DESC LIMIT 5');
  } catch (e) {
    console.log(`[exhaustion lead-lag] could not load general leaders from lead_lag_signals (${e.message}) — descriptive pass limited to BTC/market`);
  }
  const descriptiveLeaderCandidates = [...new Set([...exhaustionLeaderCandidates, ...generalLeaders.map((r) => r.leader_symbol)])];
  console.log(`[exhaustion lead-lag] descriptive pass candidates: ${descriptiveLeaderCandidates.join(', ')} (BTC/market pre-specified, rest are the top ${generalLeaders.length} already-validated general leaders from lead_lag_signals)`);
  for (const leaderSymbol of descriptiveLeaderCandidates) {
    const leaderEpisodes = allExhaustionReversals.filter((e) => e.symbol === leaderSymbol);
    const leaderTag = leaderSymbol === marketSymbolKey ? marketLabel : leaderSymbol;
    if (!leaderEpisodes.length) { console.log(`[exhaustion lead-lag] ${leaderTag}: no qualifying exhaustion reversals of its own to compare against`); continue; }
    const gaps = [];
    for (const follower of allExhaustionReversals) {
      if (follower.assetClass !== 'crypto' || follower.symbol === leaderSymbol) continue;
      let nearestGap = null;
      for (const le of leaderEpisodes) {
        if (le.dir !== follower.dir) continue;
        const gapDays = (new Date(follower.detectedDate) - new Date(le.detectedDate)) / 86400000;
        if (Math.abs(gapDays) <= 15 && (nearestGap == null || Math.abs(gapDays) < Math.abs(nearestGap))) nearestGap = gapDays;
      }
      if (nearestGap != null) gaps.push(nearestGap);
    }
    if (gaps.length >= MIN_EXHAUSTION_SAMPLE) {
      const ledCount = gaps.filter((g) => g > 0).length;
      console.log(`[exhaustion lead-lag] ${leaderTag} vs other assets' own exhaustion reversals: n=${gaps.length} paired within 15 days, median gap=${median(gaps)?.toFixed(1)} days (positive = ${leaderTag} moved first), led in ${((ledCount / gaps.length) * 100).toFixed(0)}% of paired cases`);
    } else {
      console.log(`[exhaustion lead-lag] ${leaderTag} vs other assets: too few paired same-direction episodes within 15 days (n=${gaps.length}) to say anything yet`);
    }
  }

  // Guarded hypothesis: does a candidate leader's exhaustion reversal
  // predict OTHER crypto assets' forward returns, sign-aligned to the
  // leader's own direction (pooling dip and spike episodes together — same
  // "should hold either way" pooling the pre-episode-compression hypothesis
  // above already uses, not a new judgment call). Family size = candidates
  // x HORIZONS_DAYS (2 x 2 = 4 when both BTC and a market composite are
  // available) — same size and same overall-alpha reasoning as the
  // TOD_SENTIMENT family below, so it reuses that exact Bonferroni bar
  // rather than deriving a new one for what is, when both candidates
  // exist, the identical family size.
  const exhaustionLeaderZBar = exhaustionLeaderCandidates.length > 1 ? TOD_SENTIMENT_BONFERRONI_Z : RELIABILITY_SIGNIFICANCE_Z;
  for (const leaderSymbol of exhaustionLeaderCandidates) {
    const leaderEpisodes = allExhaustionReversals.filter((e) => e.symbol === leaderSymbol);
    const leaderTag = leaderSymbol === marketSymbolKey ? marketLabel : leaderSymbol;
    if (!leaderEpisodes.length) continue; // already logged above

    for (const horizon of HORIZONS_DAYS) {
      const surgeSample = [], normalSample = [];
      for (const [symbol, { assetClass, bars }] of Object.entries(bySymbol)) {
        if (assetClass !== 'crypto' || symbol === leaderSymbol || bars.length < 90) continue;
        const sortedBars = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
        const fwd = forwardReturns(sortedBars, [horizon]);
        for (const le of leaderEpisodes) {
          const entry = fwd[le.detectedDate];
          if (entry && entry[horizon] != null) surgeSample.push({ date: `${symbol}|${le.detectedDate}`, value: le.dir === -1 ? entry[horizon] : -entry[horizon] });
        }
        const sampledDates = Object.keys(fwd).sort().filter((_, idx) => idx % 10 === 0);
        for (const d of sampledDates) {
          if (fwd[d][horizon] != null) normalSample.push({ date: `${symbol}|${d}`, value: fwd[d][horizon] });
        }
      }
      const hypothesis = `exhaustion_leader_${leaderSymbol.replace(/[:.]/g, '_')}_${horizon}d`;
      if (surgeSample.length < MIN_EXHAUSTION_SAMPLE || normalSample.length < MIN_SAMPLE_PER_BUCKET) {
        console.log(`[${hypothesis}] too few samples (leader-conditioned=${surgeSample.length}, normal=${normalSample.length}) — skipped`);
        continue;
      }
      const finding = runGuardedTest(hypothesis, 'crypto', horizon, surgeSample, normalSample, exhaustionLeaderZBar);
      if (finding) findings.push(finding);
    }
  }

  // "Bottomed, then 10x+" research (user-requested 2026-08-24, grounded in
  // ZEC's real archived history: $18.29 low 2024-07-05, $786.42 on
  // 2026-08-23, a confirmed 43x, still accelerating). Same universe
  // (bySymbol) and same pooled + chronological-half-split rigor as every
  // hypothesis above. detectBottomThenMoonshot (worker.js) only returns
  // troughs that DID go on to multiply -- for a genuine "what's different
  // about the ones that moonshot" comparison, this also needs a CONTROL
  // group of real, isolated troughs that DIDN'T. findAllIsolatedTroughs
  // below mirrors that same function's own trough-finding logic (a real
  // local min, with the "does an even deeper low follow before anything
  // is achieved" correction its own live ZEC test caught and fixed) but
  // without the >=10x gate, so every genuine trough -- moonshot or not --
  // comes back with whatever multiple it actually achieved. Kept local to
  // this research script rather than exported from worker.js: it's
  // exploratory instrumentation for this one question, not a primitive
  // anything live needs.
  function findAllIsolatedTroughs(bars, troughWindowDays, maxForwardDays) {
    const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const n = sorted.length;
    const troughs = [];
    let cooldownUntil = -1;
    for (let i = 0; i < n; i++) {
      if (i <= cooldownUntil) continue;
      const troughClose = sorted[i].close;
      if (troughClose == null || troughClose <= 0) continue;
      let isMin = true;
      const lo = Math.max(0, i - troughWindowDays), hi = Math.min(n - 1, i + troughWindowDays);
      for (let j = lo; j <= hi; j++) {
        if (j === i) continue;
        if (sorted[j].close != null && sorted[j].close < troughClose) { isMin = false; break; }
      }
      if (!isMin) continue;
      let peakIdx = i, peakClose = troughClose, deeperLowFound = false;
      for (let j = i + 1; j < Math.min(n, i + maxForwardDays); j++) {
        const c = sorted[j].close;
        if (c == null) continue;
        if (c < troughClose) { deeperLowFound = true; break; }
        if (c > peakClose) { peakClose = c; peakIdx = j; }
      }
      if (deeperLowFound) continue;
      troughs.push({ idx: i, date: sorted[i].date, close: troughClose, peakIdx, peakClose, multiple: peakClose / troughClose });
      cooldownUntil = Math.max(peakIdx, i + 180);
    }
    return troughs;
  }

  const MOONSHOT_MULTIPLE = 10;
  const MOONSHOT_TROUGH_WINDOW_DAYS = 90;
  const MOONSHOT_MAX_FORWARD_DAYS = 1095; // ~3 years
  const MOONSHOT_DRAWDOWN_LOOKBACK_DAYS = 730; // ~2 years trailing, for "how far below its own recent high"
  const MIN_MOONSHOT_SAMPLE = 10; // rarer still than an exhaustion reversal — a real isolated trough AND (for the treatment group) a >=10x follow-through

  const allTroughs = []; // { symbol, assetClass, ...trough, isMoonshot, drawdownPct, compression }
  for (const [symbol, { assetClass, bars }] of Object.entries(bySymbol)) {
    if (assetClass !== 'crypto' || bars.length < 400) continue;
    const sortedBars = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const closes = sortedBars.map((b) => b.close);
    for (const t of findAllIsolatedTroughs(sortedBars, MOONSHOT_TROUGH_WINDOW_DAYS, MOONSHOT_MAX_FORWARD_DAYS)) {
      const lookStart = Math.max(0, t.idx - MOONSHOT_DRAWDOWN_LOOKBACK_DAYS);
      const trailingHigh = Math.max(...closes.slice(lookStart, t.idx + 1).filter((c) => c != null));
      const drawdownPct = trailingHigh > 0 ? ((t.close / trailingHigh) - 1) * 100 : null;
      const compression = volRegime(closes.slice(0, t.idx + 1), 20, 60);
      allTroughs.push({ symbol, assetClass, ...t, isMoonshot: t.multiple >= MOONSHOT_MULTIPLE, drawdownPct, compression });
    }
  }
  const moonshots = allTroughs.filter((t) => t.isMoonshot);
  const controls = allTroughs.filter((t) => !t.isMoonshot);
  console.log(`\nbottom-then-moonshot research: ${allTroughs.length} genuine isolated troughs found across ${Object.keys(bySymbol).length} symbols (>=400 days history) -- ${moonshots.length} went on to >=${MOONSHOT_MULTIPLE}x within ~${Math.round(MOONSHOT_MAX_FORWARD_DAYS / 365)}y, ${controls.length} did not`);
  if (moonshots.length) {
    console.log(`[moonshot stats] median days trough-to-peak=${median(moonshots.map((m) => m.peakIdx - m.idx))}, median eventual multiple=${median(moonshots.map((m) => m.multiple))?.toFixed(1)}x, median drawdown from trailing 2y high=${median(moonshots.map((m) => m.drawdownPct).filter((v) => v != null))?.toFixed(1)}%`);
    console.log(`[moonshot examples] ${moonshots.slice(0, 8).map((m) => `${m.symbol}@${m.date} (${m.multiple.toFixed(1)}x)`).join(', ')}`);
  }

  const drawdownMoonshot = moonshots.map((t) => ({ date: t.date, value: t.drawdownPct })).filter((p) => p.value != null);
  const drawdownControl = controls.map((t) => ({ date: t.date, value: t.drawdownPct })).filter((p) => p.value != null);
  const drawdownHypothesis = 'moonshot_trough_deeper_drawdown_than_control';
  if (drawdownMoonshot.length < MIN_MOONSHOT_SAMPLE || drawdownControl.length < MIN_MOONSHOT_SAMPLE) {
    console.log(`[${drawdownHypothesis}] too few samples (moonshot=${drawdownMoonshot.length}, control=${drawdownControl.length}) — skipped`);
  } else {
    const finding = runGuardedTest(drawdownHypothesis, 'crypto', null, drawdownMoonshot, drawdownControl);
    if (finding) findings.push(finding);
  }

  const compressionMoonshot = moonshots.map((t) => ({ date: t.date, value: t.compression })).filter((p) => p.value != null);
  const compressionControl = controls.map((t) => ({ date: t.date, value: t.compression })).filter((p) => p.value != null);
  const moonshotCompressionHypothesis = 'moonshot_trough_more_compressed_than_control';
  if (compressionMoonshot.length < MIN_MOONSHOT_SAMPLE || compressionControl.length < MIN_MOONSHOT_SAMPLE) {
    console.log(`[${moonshotCompressionHypothesis}] too few samples (moonshot=${compressionMoonshot.length}, control=${compressionControl.length}) — skipped`);
  } else {
    const finding = runGuardedTest(moonshotCompressionHypothesis, 'crypto', null, compressionMoonshot, compressionControl);
    if (finding) findings.push(finding);
  }

  // Market-wide coincidence, properly tested this time — user-requested
  // 2026-08-24 follow-up: the first pass only described HOW OFTEN moonshot
  // troughs were coincident with others (79%), which doesn't actually say
  // whether coincidence PREDICTS anything — ordinary troughs might be just
  // as commonly coincident, in which case a crowded bottom is simply the
  // usual backdrop either way, not a real signal. This computes the same
  // coincidence COUNT (other tracked symbols with their own trough within
  // 60 days) for every real trough, moonshot AND control alike, then runs
  // the same guarded pooled + chronological-half-split test as every
  // other hypothesis here — an actual comparison, not just one group's
  // own description.
  const troughDatesBySymbol = {};
  for (const t of allTroughs) (troughDatesBySymbol[t.symbol] ??= []).push(t.date);
  function coincidentCount(trough) {
    const windowStart = new Date(new Date(trough.date).getTime() - 60 * 86400000).toISOString().slice(0, 10);
    const windowEnd = new Date(new Date(trough.date).getTime() + 60 * 86400000).toISOString().slice(0, 10);
    let n = 0;
    for (const [sym, dates] of Object.entries(troughDatesBySymbol)) {
      if (sym === trough.symbol) continue;
      if (dates.some((d) => d >= windowStart && d <= windowEnd)) n++;
    }
    return n;
  }
  const moonshotCoincidence = moonshots.map((t) => ({ date: t.date, value: coincidentCount(t) }));
  const controlCoincidence = controls.map((t) => ({ date: t.date, value: coincidentCount(t) }));
  if (moonshots.length) {
    const systemicCount = moonshotCoincidence.filter((c) => c.value >= 3).length;
    const controlSystemicCount = controlCoincidence.filter((c) => c.value >= 3).length;
    console.log(`[moonshot market-wide coincidence] moonshot troughs: ${systemicCount}/${moonshots.length} (${((systemicCount / moonshots.length) * 100).toFixed(0)}%) had >=3 other symbols also trough within 60 days -- control (non-moonshot) troughs: ${controlSystemicCount}/${controls.length} (${controls.length ? ((controlSystemicCount / controls.length) * 100).toFixed(0) : 'n/a'}%)`);
  }
  const coincidenceHypothesis = 'moonshot_trough_more_coincident_than_control';
  if (moonshotCoincidence.length < MIN_MOONSHOT_SAMPLE || controlCoincidence.length < MIN_MOONSHOT_SAMPLE) {
    console.log(`[${coincidenceHypothesis}] too few samples (moonshot=${moonshotCoincidence.length}, control=${controlCoincidence.length}) — skipped`);
  } else {
    const finding = runGuardedTest(coincidenceHypothesis, 'crypto', null, moonshotCoincidence, controlCoincidence);
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
