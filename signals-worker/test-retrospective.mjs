import assert from 'node:assert/strict';
import {
  RETRO_BASELINE_METHOD_VERSION,
  RETRO_LEAD_LAG_FAMILY_TESTS,
  RETRO_LEAD_LAG_METHOD_VERSION,
  buildLeadLagDailySnapshot,
  buildSeasonalLeadLagEvidence,
  buildFeatureCorrelationEvidence,
  buildMissFeatureSnapshotRows,
  compactLeadLagPredictorFrames,
  decodePublicationSnapshot,
  flattenLeadLagDailySnapshots,
  favoriteMoveBaseline,
  hacCorrelationStats,
  inverseNormalCdf,
  pointInTimeMarketMetrics,
  quantile,
  retrospectiveTimeBucket,
  retrospectiveTrigger,
  seasonalConditionCells,
  selectLaggedPredictorRuns,
  walkForwardCorrelationStability
} from './scripts/retrospective.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

function dailyBars(returnsPct, rangePct = 2) {
  let close = 100;
  const bars = [{ date: '2026-01-01', close, high: 101, low: 99 }];
  for (let i = 0; i < returnsPct.length; i++) {
    const previous = close;
    close *= 1 + returnsPct[i] / 100;
    const date = new Date(Date.UTC(2026, 0, i + 2)).toISOString().slice(0, 10);
    bars.push({ date, close, high: previous * (1 + rangePct / 200), low: previous * (1 - rangePct / 200) });
  }
  return bars;
}

test('quantile interpolates deterministic finite observations', () => {
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([NaN, 7], 0.8), 7);
});

test('deep quiet history earns a lower favorite-only unusual-move threshold', () => {
  const baseline = favoriteMoveBaseline(dailyBars(Array.from({ length: 90 }, (_, i) => i % 2 ? -1 : 1)), {
    globalThreshold: 12,
    minSamples: 60
  });
  assert.equal(baseline.status, 'adaptive');
  assert.ok(baseline.effectiveThresholdPct >= 1 && baseline.effectiveThresholdPct < 12);
  assert.equal(baseline.methodVersion, RETRO_BASELINE_METHOD_VERSION);
  assert.equal(baseline.samples, 90);
});

test('thin history abstains from adaptation instead of inventing a threshold', () => {
  const baseline = favoriteMoveBaseline(dailyBars(Array(20).fill(1)), { globalThreshold: 12, minSamples: 60 });
  assert.equal(baseline.status, 'insufficient');
  assert.equal(baseline.effectiveThresholdPct, 12);
});

test('an unusually volatile favorite never raises or weakens the broad trigger', () => {
  const baseline = favoriteMoveBaseline(dailyBars(Array.from({ length: 90 }, (_, i) => i % 2 ? -16 : 16), 20), {
    globalThreshold: 12,
    minSamples: 60
  });
  assert.equal(baseline.status, 'global');
  assert.equal(baseline.effectiveThresholdPct, 12);
});

test('adaptive threshold applies only to a named always-tracked asset', () => {
  const baseline = { status: 'adaptive', effectiveThresholdPct: 4, samples: 90, fitThrough: '2026-09-01' };
  const favorite = retrospectiveTrigger({ symbol: 'BTC', movePct: 5, baseline, globalThreshold: 12, favoriteSymbols: new Set(['BTC']) });
  const ordinary = retrospectiveTrigger({ symbol: 'ARB', movePct: 5, baseline, globalThreshold: 12, favoriteSymbols: new Set(['BTC']) });
  assert.equal(favorite.triggered, true);
  assert.equal(favorite.alwaysTracked, true);
  assert.equal(ordinary.triggered, false);
  assert.equal(ordinary.thresholdPct, 12);
});

test('time bucket is derived from the pre-outcome cutoff, in UTC', () => {
  assert.equal(retrospectiveTimeBucket('2026-09-08T13:42:00.000Z'), 'tue_utc_12_17');
  assert.equal(retrospectiveTimeBucket('invalid'), 'unknown');
});

test('miss snapshots use only lagged directional votes and exclude caught episodes', () => {
  const cutoff = '2026-09-08T12:00:00.000Z';
  const episodes = [
    { run_at: '2026-09-09T12:00:00.000Z', asset_class: 'crypto', symbol: 'BTC', move_pct: 8, move_dir: 1, cause: 'unranked', feature_cutoff_at: cutoff },
    { run_at: '2026-09-09T12:00:00.000Z', asset_class: 'crypto', symbol: 'ETH', move_pct: -9, move_dir: -1, cause: 'caught', feature_cutoff_at: cutoff }
  ];
  const snapshots = {
    BTC: { runAt: '2026-09-08T11:00:00.000Z', votes: [
      { technique_id: 'momentum', dir: 1, score: 0.8, regime: 'risk-on' },
      { technique_id: 'neutral', dir: 0, score: 0, regime: 'risk-on' }
    ] },
    ETH: { runAt: '2026-09-08T11:00:00.000Z', votes: [{ technique_id: 'momentum', dir: -1, score: 0.7, regime: 'risk-off' }] }
  };
  const rows = buildMissFeatureSnapshotRows(episodes, snapshots);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTC');
  assert.equal(rows[0].aligned, 1);
  assert.equal(rows[0].source_lag_hours, 1);
});

test('post-cutoff and stale feature state is rejected', () => {
  const episode = { run_at: '2026-09-09T12:00:00.000Z', asset_class: 'crypto', symbol: 'BTC', move_pct: 8, move_dir: 1, cause: 'unranked', feature_cutoff_at: '2026-09-08T12:00:00.000Z' };
  const vote = { technique_id: 'momentum', dir: 1, score: 0.8, regime: 'risk-on' };
  assert.equal(buildMissFeatureSnapshotRows([episode], { BTC: { runAt: '2026-09-08T13:00:00.000Z', votes: [vote] } }).length, 0);
  assert.equal(buildMissFeatureSnapshotRows([episode], { BTC: { runAt: '2026-09-07T11:00:00.000Z', votes: [vote] } }).length, 0);
});

function evidenceRows(days, directionForIndex, moveForIndex) {
  return Array.from({ length: days }, (_, i) => ({
    run_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    asset_class: 'crypto', symbol: 'BTC', technique_id: 'momentum',
    technique_dir: directionForIndex(i), move_pct: moveForIndex(i),
    aligned: Math.sign(moveForIndex(i)) === directionForIndex(i) ? 1 : 0,
    regime: 'risk-on', time_bucket: 'tue_utc_12_17'
  }));
}

test('strong split-stable retrospective correlation is notable but never live-eligible', () => {
  const rows = evidenceRows(40, (i) => i % 2 ? -1 : 1, (i) => (i % 2 ? -10 : 10));
  const [evidence] = buildFeatureCorrelationEvidence(rows, { minIndependentDates: 20 });
  assert.equal(evidence.status, 'notable-retrospective-only');
  assert.equal(evidence.liveEdgeEligible, 0);
  assert.equal(evidence.independentDates, 40);
  assert.ok(evidence.correlation > 0.99);
});

test('duplicate workflow runs do not masquerade as independent evidence', () => {
  const base = evidenceRows(10, (i) => i % 2 ? -1 : 1, (i) => (i % 2 ? -10 : 10));
  const duplicated = base.flatMap((row) => [row, { ...row, run_at: row.run_at.replace('00:00:00', '04:00:00') }]);
  const [evidence] = buildFeatureCorrelationEvidence(duplicated, { minIndependentDates: 20 });
  assert.equal(evidence.n, 20);
  assert.equal(evidence.independentDates, 10);
  assert.equal(evidence.status, 'insufficient');
  assert.equal(evidence.liveEdgeEligible, 0);
});

test('normal inverse is numerically sane for the familiar 97.5th percentile', () => {
  assert.ok(Math.abs(inverseNormalCdf(0.975) - 1.95996) < 0.001);
});

test('seasonal contexts use the outcome-window start and frozen target regime', () => {
  const cells = seasonalConditionCells('2026-09-08T13:42:00.000Z', 'trending');
  assert.ok(cells.some((cell) => cell.type === 'calendar-quarter' && cell.value === 'q3'));
  assert.ok(cells.some((cell) => cell.type === 'weekday' && cell.value === 'tue'));
  assert.ok(cells.some((cell) => cell.type === 'quarter-target-regime' && cell.value === 'q3|trending'));
  assert.ok(!cells.some((cell) => cell.type === 'calendar-month'));
  assert.ok(!cells.some((cell) => cell.type === 'window-utc-session'));
});

function voteRun(runAt, symbols, direction = 1) {
  return symbols.flatMap((symbol, index) => [
    { run_at: runAt, symbol, technique_id: 'momentum', dir: index % 2 ? -direction : direction, score: null, regime: 'trending' },
    { run_at: runAt, symbol, technique_id: 'composite', dir: index % 2 ? -direction : direction, score: 60, regime: 'trending' }
  ]);
}

test('lag selection rejects boundary, incomplete, and stale runs without substituting them', () => {
  const symbols = Array.from({ length: 20 }, (_, index) => `S${index}`);
  const rows = [
    ...voteRun('2026-09-08T10:00:00.000Z', symbols),
    ...voteRun('2026-09-08T11:00:00.000Z', symbols.slice(0, 5)),
    ...voteRun('2026-09-08T12:00:00.000Z', symbols)
  ];
  const selected = selectLaggedPredictorRuns(rows, '2026-09-08T12:00:00.000Z', {
    lags: [0, 1, 8], maxStalenessHours: 3, minRunAssets: 20
  });
  assert.deepEqual(selected.map((row) => row.lagHours), [0, 1]);
  assert.equal(selected[0].sourceRunAt, '2026-09-08T10:00:00.000Z');
  assert.equal(selected[1].sourceRunAt, '2026-09-08T10:00:00.000Z');
  assert.ok(selected.every((row) => row.sourceRunAt < row.anchorAt));
});

test('cycle metrics require causal availability and a deep causal percentile', () => {
  const base = {
    metric: 'btc_mvrv', context_date: '2026-09-07', provider: 'coinmetrics-community', method_version: 'fcs-market-context-v1',
    source_timestamp: '2026-09-08T00:00:00.000Z', known_at: '2026-09-08T01:00:00.000Z',
    training_percentile: 0.8, training_n: 100
  };
  const metrics = pointInTimeMarketMetrics([
    base,
    { ...base, metric: 'future-known', known_at: '2026-09-08T13:00:00.000Z' },
    { ...base, metric: 'thin', training_n: 10 },
    { ...base, metric: 'stale', source_timestamp: '2026-08-01T00:00:00.000Z' }
  ], '2026-09-08T12:00:00.000Z');
  assert.deepEqual(Object.keys(metrics), ['btc_mvrv|coinmetrics-community|fcs-market-context-v1']);
  assert.equal(metrics['btc_mvrv|coinmetrics-community|fcs-market-context-v1'][0], 0.8);
});

test('unregistered cycle-provider variants cannot silently expand the research family', () => {
  const metrics = pointInTimeMarketMetrics([{
    metric: 'btc_mvrv', context_date: '2026-09-07', provider: 'new-provider', method_version: 'v99',
    source_timestamp: '2026-09-07T00:00:00.000Z', known_at: '2026-09-07T01:00:00.000Z',
    training_percentile: 0.9, training_n: 100
  }], '2026-09-08T12:00:00.000Z');
  assert.deepEqual(metrics, {});
});

test('daily lead/lag archive keeps every eligible engine outcome, not only movers', () => {
  const selectedRuns = [{
    lagHours: 0, anchorAt: '2026-09-08T12:00:00.000Z', sourceRunAt: '2026-09-08T11:00:00.000Z', sourceAgeHours: 1,
    votes: [
      { symbol: 'BTC', technique_id: 'momentum', dir: 1, regime: 'trending' },
      { symbol: 'BTC', technique_id: 'composite', dir: 1, score: 60, regime: 'trending' },
      { symbol: 'ETH', technique_id: 'momentum', dir: -1, regime: 'choppy' }
    ]
  }];
  const rankedMarkets = [
    { rank: 1, c: { symbol: 'btc', name: 'Bitcoin', price_change_percentage_24h: 1.2, market_cap: 1e12, total_volume: 1e10, current_price: 100 } },
    { rank: 2, c: { symbol: 'eth', name: 'Ethereum', price_change_percentage_24h: -2.1, market_cap: 5e11, total_volume: 1e10, current_price: 100 } },
    { rank: 3, c: { symbol: 'xrp', name: 'XRP', price_change_percentage_24h: 20, market_cap: 1e11, total_volume: 1e9, current_price: 1 } }
  ];
  const snapshot = buildLeadLagDailySnapshot({
    runAt: '2026-09-09T12:00:00.000Z', windowStartAt: '2026-09-08T12:00:00.000Z',
    rankedMarkets, selectedRuns
  });
  assert.equal(snapshot.methodVersion, RETRO_LEAD_LAG_METHOD_VERSION);
  assert.deepEqual(Object.keys(snapshot.outcomes).sort(), ['BTC', 'ETH']);
  assert.equal(snapshot.outcomes.BTC.p, 1.2);
});

test('endpoint rank and liquidity cannot delete a pre-window eligible outcome', () => {
  const selectedRuns = [{
    lagHours: 0, anchorAt: '2026-09-08T12:00:00.000Z', sourceRunAt: '2026-09-08T11:00:00.000Z', sourceAgeHours: 1,
    votes: [{ symbol: 'BTC', technique_id: 'composite', dir: 1, score: 60, regime: 'trending' }]
  }];
  const snapshot = buildLeadLagDailySnapshot({
    runAt: '2026-09-09T12:00:00.000Z', windowStartAt: '2026-09-08T12:00:00.000Z',
    selectedRuns,
    rankedMarkets: [{ rank: 999, c: {
      symbol: 'btc', price_change_percentage_24h: -15,
      market_cap: 1, total_volume: 1, current_price: 1
    } }]
  });
  assert.equal(snapshot.outcomes.BTC.p, -15);
  assert.equal(snapshot.outcomes.BTC.rank, 999);
});

test('publication snapshot decoder preserves withheld and conflicting boards exactly', () => {
  const decoded = decodePublicationSnapshot({
    run_at: '2026-09-08T11:00:00.000Z', universe_count: 3,
    universe_json: JSON.stringify(['BTC', 'ETH', 'PEPE']),
    boards_json: JSON.stringify([
      { section: 'favorites', symbol: 'BTC', dir: 0, score: 81 },
      { section: 'breakout', symbol: 'ETH', dir: 1, score: 91 },
      { section: 'breakdown', symbol: 'ETH', dir: -1, score: 89 }
    ])
  }, ['BTC', 'ETH']);
  assert.equal(decoded.states.BTC.withheld, true);
  assert.deepEqual(decoded.states.ETH.directions, [-1, 1]);
  assert.equal(decoded.universe.has('PEPE'), true);
  assert.equal(decodePublicationSnapshot({
    run_at: '2026-09-08T11:00:00.000Z', universe_count: 4,
    universe_json: '[]', boards_json: '[]'
  }), null);
});

test('market breadth divides by observed composites and reports coverage separately', () => {
  const votes = Array.from({ length: 20 }, (_, index) => ({
    symbol: `S${index}`, technique_id: index < 10 ? 'composite' : 'momentum',
    dir: index < 8 ? 1 : -1, score: index < 10 ? 60 : null, regime: 'mixed'
  }));
  const [frame] = compactLeadLagPredictorFrames([{
    lagHours: 0, anchorAt: '2026-09-08T12:00:00.000Z',
    sourceRunAt: '2026-09-08T11:00:00.000Z', sourceAgeHours: 1, votes
  }]);
  assert.deepEqual(frame.breadth, [0.6, 10, 20]);
});

test('flattening emits own, agreed-combo, cross-asset, breadth, and cycle predictors with no look-ahead', () => {
  const daily = [{
    observation_date: '2026-09-09', window_start_at: '2026-09-08T12:00:00.000Z', window_end_at: '2026-09-09T12:00:00.000Z',
    outcomes_json: JSON.stringify({ BTC: { p: 4, r: 'trending' } }),
    predictors_json: JSON.stringify({ frames: [{
      l: 6, a: '2026-09-08T06:00:00.000Z', s: '2026-09-08T05:00:00.000Z',
      assets: {
        BTC: { r: 'trending', v: { bollinger: [1, null], rsi: [1, 25], composite: [1, 70] } },
        ETH: { r: 'choppy', v: { composite: [-1, 80] } }
      },
      breadth: [0.2, 20, 50],
      metrics: { 'btc_mvrv|coinmetrics-community|fcs-market-context-v1': [0.8, '2026-09-07T00:00:00.000Z', '2026-09-07T01:00:00.000Z', 100] }
    }] })
  }];
  const rows = flattenLeadLagDailySnapshots(daily, { targetSymbols: new Set(['BTC']), crossAssetSymbols: new Set(['ETH']) });
  const all = rows.filter((row) => row.context_type === 'all');
  assert.ok(all.some((row) => row.feature_kind === 'technique' && row.feature_id === 'rsi'));
  assert.ok(all.some((row) => row.feature_kind === 'technique-combo' && row.feature_id === 'bollinger+rsi'));
  assert.ok(all.some((row) => row.feature_kind === 'cross-asset-composite' && row.source_symbol === 'ETH'));
  assert.ok(all.some((row) => row.feature_kind === 'asset-combination'));
  assert.ok(all.some((row) => row.feature_kind === 'market-cycle-metric'));
  assert.ok(all.every((row) => row.actual_lead_hours >= 6));
  assert.equal(all.find((row) => row.feature_kind === 'technique' && row.feature_id === 'rsi').predictor_value, 1);
  assert.equal(all.find((row) => row.feature_kind === 'technique' && row.feature_id === 'composite').predictor_value, 0.7);
  assert.equal(all.find((row) => row.feature_kind === 'market-cycle-metric').actual_lead_hours, 35);
  assert.ok(rows.some((row) => row.context_type === 'target-regime' && row.context_value === 'trending'));

  const leaked = JSON.parse(daily[0].predictors_json);
  leaked.frames[0].s = '2026-09-08T07:00:00.000Z';
  assert.equal(flattenLeadLagDailySnapshots([{ ...daily[0], predictors_json: JSON.stringify(leaked) }], {
    targetSymbols: new Set(['BTC']), crossAssetSymbols: new Set(['ETH'])
  }).length, 0);
});

function leadLagRows(count, direction = 1, startDay = 0) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 0, startDay + index + 1));
    const x = index % 2 ? -1 : 1;
    // Small deterministic perturbation prevents a degenerate zero-variance
    // product while preserving a strong, stable relationship.
    const noise = ((index % 5) - 2) * 0.08;
    return {
      observation_date: at.toISOString().slice(0, 10), window_end_at: at.toISOString(),
      asset_class: 'crypto', target_symbol: 'BTC', feature_kind: 'technique',
      source_symbol: 'BTC', feature_id: 'momentum', indicator_role: 'confirming-lagging',
      lag_hours: 6, actual_lead_hours: 7, context_type: 'all', context_value: 'all',
      predictor_value: x, outcome_return_pct: direction * x * 5 + noise
    };
  });
}

test('HAC correlation and anchored walk-forward preserve a stable relationship', () => {
  const rows = leadLagRows(64);
  const stats = hacCorrelationStats(rows);
  const walk = walkForwardCorrelationStability(rows);
  assert.ok(stats.correlation > 0.99);
  assert.ok(stats.z > 5);
  assert.equal(walk.verdict, 'passed');
  assert.ok(walk.positiveFolds >= 2);
});

test('seasonal lead/lag discovery is checkpointed, corrected, held out, and never live', () => {
  const early = buildSeasonalLeadLagEvidence(leadLagRows(63), [], {
    minDiscoveryDates: 40, minHoldoutDates: 20, minOosDates: 20
  })[0];
  assert.equal(early.status, 'descriptive-only');
  assert.equal(early.discoveryFitThrough, null);

  const provisional = buildSeasonalLeadLagEvidence(leadLagRows(64), [], {
    minDiscoveryDates: 40, minHoldoutDates: 20, minOosDates: 20
  })[0];
  assert.equal(provisional.status, 'provisional-research-only');
  assert.equal(provisional.n, 64);
  assert.equal(provisional.discoveryTestsInFamily, 1);
  assert.ok(provisional.correctedZThreshold > 2.5);
  assert.equal(provisional.walkForwardVerdict, 'passed');
  assert.equal(provisional.liveEdgeEligible, 0);
});

test('production seasonal research charges the fixed pre-registered family', () => {
  const [row] = buildSeasonalLeadLagEvidence(leadLagRows(64), [], {
    minDiscoveryDates: 40, minHoldoutDates: 20, minOosDates: 20,
    testsInFamilyOverride: RETRO_LEAD_LAG_FAMILY_TESTS,
    oosTestsInFamilyOverride: RETRO_LEAD_LAG_FAMILY_TESTS
  });
  assert.equal(row.discoveryTestsInFamily, RETRO_LEAD_LAG_FAMILY_TESTS);
  assert.ok(row.correctedZThreshold > 4);
  assert.equal(row.liveEdgeEligible, 0);
});

test('only observations after frozen discovery can replicate or decay a lead/lag candidate', () => {
  const base = leadLagRows(64);
  const [provisional] = buildSeasonalLeadLagEvidence(base, [], {
    minDiscoveryDates: 40, minHoldoutDates: 20, minOosDates: 20
  });
  const prior = {
    asset_class: provisional.assetClass, target_symbol: provisional.targetSymbol,
    feature_kind: provisional.featureKind, source_symbol: provisional.sourceSymbol,
    feature_id: provisional.featureId, indicator_role: provisional.indicatorRole,
    lag_hours: provisional.lagHours, context_type: provisional.contextType,
    context_value: provisional.contextValue, discovery_fit_through: provisional.discoveryFitThrough,
    discovered_at: provisional.discoveredAt, discovery_correlation: provisional.discoveryCorrelation,
    discovery_hac_z: provisional.discoveryHacZ, holdout_n: provisional.holdoutN,
    holdout_correlation: provisional.holdoutCorrelation, holdout_hac_z: provisional.holdoutHacZ,
    discovery_tests_in_family: provisional.discoveryTestsInFamily,
    corrected_z_threshold: provisional.correctedZThreshold,
    family_alpha_spent: provisional.familyAlphaSpent,
    walk_forward_verdict: provisional.walkForwardVerdict,
    walk_forward_folds: provisional.walkForwardFolds,
    walk_forward_positive_folds: provisional.walkForwardPositiveFolds,
    status: provisional.status
  };
  const replicated = buildSeasonalLeadLagEvidence([...base, ...leadLagRows(32, 1, 64)], [prior], {
    minDiscoveryDates: 40, minHoldoutDates: 20, minOosDates: 20
  })[0];
  assert.equal(replicated.oosN, 32);
  assert.equal(replicated.status, 'replicated-research-only');
  assert.ok(replicated.oosCorrectedZThreshold > 1.96);
  assert.equal(replicated.liveEdgeEligible, 0);

  const decayed = buildSeasonalLeadLagEvidence([...base, ...leadLagRows(32, -1, 64)], [prior], {
    minDiscoveryDates: 40, minHoldoutDates: 20, minOosDates: 20
  })[0];
  assert.equal(decayed.status, 'decayed-research-only');
  assert.equal(decayed.liveEdgeEligible, 0);
});

console.log(`\n${passed} retrospective tests passed`);
