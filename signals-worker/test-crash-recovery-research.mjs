import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  HORIZONS_BY_ASSET_CLASS,
  associationAggregationSql,
  associationFeatureBuckets,
  boundedBarResult,
  calendarCohort,
  checkpointBeforeSignal,
  createPublicationResolver,
  decodePublicationForSymbol,
  detectCrashRecoveryEpisodes,
  episodeInsertStatement,
  finiteNumber,
  forwardOutcomeForSignal,
  insufficientHistoryCheckpoint,
  normalizeDailyBars,
  outcomeUpsertStatement,
  physicalBarReadPlan,
  physicalBarReadResult,
  publicationCallBucket
} from './scripts/crash-recovery-research.mjs';

const migration = readFileSync(new URL(
  './migrations/0029_crash_recovery_research.sql', import.meta.url
), 'utf8');

function utcDay(offset) {
  return new Date(Date.parse('2020-01-01T00:00:00.000Z') + offset * 86_400_000)
    .toISOString().slice(0, 10);
}

function barsFromCloses(closes, volumes = []) {
  return closes.map((close, index) => ({
    date: utcDay(index), close, volume: volumes[index] ?? null, source: 'fixture'
  }));
}

function crossingFixture() {
  // Index 20 is still above the threshold; index 21 is the first -35% close.
  // Index 22 is therefore the only admissible reference entry.
  return barsFromCloses([
    ...Array(20).fill(100), 90, 65, 70, 140, 350, 700, 1_400, 60
  ]);
}

test('missing numeric fields remain missing instead of becoming zero', () => {
  assert.equal(finiteNumber(null), null);
  assert.equal(finiteNumber(undefined), null);
  assert.equal(finiteNumber(''), null);
  assert.equal(finiteNumber('   '), null);
  assert.equal(finiteNumber(false), null);
  assert.equal(finiteNumber([]), null);
  assert.equal(finiteNumber('0'), 0);
  const bars = normalizeDailyBars([{ date: '2026-09-09', close: '10', volume: null, source: 'x' }]);
  assert.equal(bars[0].volume, null);
});

test('candidate features are point-in-time and the next bar is the reference entry', () => {
  const partial = crossingFixture().slice(0, 23);
  const completed = crossingFixture();
  const options = { lookbackSessions: 20, cooldownSessions: 20, horizonSessions: [2, 5], maturedAt: '2026-01-01T00:00:00.000Z' };
  const before = detectCrashRecoveryEpisodes(partial, options)[0];
  const after = detectCrashRecoveryEpisodes(completed, options)[0];
  assert.equal(before.signalDate, utcDay(21));
  assert.equal(before.eligibleAt, utcDay(22));
  assert.equal(before.referenceEntryClose, 70);
  for (const field of ['signalDate', 'signalClose', 'trailingPeakClose', 'drawdownPct',
    'trailingReturn20Pct', 'realizedVol20Pct', 'volumeRatio20', 'distanceSma200Pct']) {
    assert.equal(after[field], before[field], `${field} changed after future bars were appended`);
  }
  assert.equal(before.outcomes[0].outcomeStatus, 'pending');
  assert.equal(after.outcomes[0].outcomeStatus, 'matured');
});

test('one path records distinct horizons and ordered 2x/5x/10x/20x milestones', () => {
  const episode = detectCrashRecoveryEpisodes(crossingFixture(), {
    lookbackSessions: 20, cooldownSessions: 20, horizonSessions: [2, 5],
    maturedAt: '2026-01-01T00:00:00.000Z'
  })[0];
  assert.deepEqual(episode.outcomes.map((outcome) => outcome.horizonSessions), [2, 5]);
  const short = episode.outcomes[0];
  assert.equal(short.first2xSessions, 1);
  assert.equal(short.first5xSessions, 2);
  assert.equal(short.first10xSessions, null);
  assert.equal(short.first20xSessions, null);
  const long = episode.outcomes[1];
  assert.deepEqual([
    long.first2xSessions, long.first5xSessions,
    long.first10xSessions, long.first20xSessions
  ], [1, 2, 3, 4]);
  assert.equal(long.sessionsToRecovery, 1);
  assert.equal(long.hindsightLowDate, utcDay(27));
  assert.equal(long.sessionsToHindsightLow, 5);
  assert.equal(long.hindsightLowClose, 60);
});

test('right-censored paths cannot become failures or expose future-path labels', () => {
  const bars = crossingFixture().slice(0, 24);
  const outcome = forwardOutcomeForSignal(bars, 21, 100, 5, '2026-01-01T00:00:00.000Z');
  assert.equal(outcome.outcomeStatus, 'pending');
  assert.equal(outcome.observedForwardSessions, 1);
  for (const field of ['outcomeLabel', 'recoveredPriorPeak', 'first2xSessions',
    'forwardTerminalReturnPct', 'forwardMaxReturnPct', 'forwardMaxAdversePct',
    'hindsightLowClose', 'hindsightLowDate', 'maturedAt']) {
    assert.equal(outcome[field], null, `${field} leaked before maturity`);
  }
});

test('cooldown suppresses overlapping recrossings', () => {
  const bars = barsFromCloses([
    ...Array(20).fill(100), 90, 65, 100, 65, ...Array(25).fill(100)
  ]);
  const episodes = detectCrashRecoveryEpisodes(bars, {
    lookbackSessions: 20, cooldownSessions: 20, horizonSessions: [2]
  });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].signalDate, utcDay(21));
  assert.throws(() => detectCrashRecoveryEpisodes(bars, { thresholdPct: 1 }), /threshold/);
});

test('asset calendars have predeclared one- and two-year clocks', () => {
  assert.deepEqual(HORIZONS_BY_ASSET_CLASS.crypto, [365, 730]);
  assert.deepEqual(HORIZONS_BY_ASSET_CLASS.stock, [252, 504]);
  assert.equal(calendarCohort('2026-09-09'), '2026-Q3');
});

test('publication decoding preserves published side, conflict, withheld, and null score', () => {
  const base = {
    run_at: '2026-09-08T12:00:00.000Z', universe_count: 2,
    universe_json: JSON.stringify(['ZEC', 'BTC'])
  };
  const published = decodePublicationForSymbol({
    ...base, boards_json: JSON.stringify([{ symbol: 'ZEC', dir: 1, score: null }])
  }, 'ZEC');
  assert.equal(published.publicationState, 'published');
  assert.equal(published.publishedScore, null);
  assert.equal(publicationCallBucket(published), 'published-long');
  const conflicted = decodePublicationForSymbol({
    ...base, boards_json: JSON.stringify([
      { symbol: 'ZEC', dir: 1, score: 80 }, { symbol: 'ZEC', dir: -1, score: 75 }
    ])
  }, 'ZEC');
  assert.equal(conflicted.publicationState, 'conflicted');
  const withheld = decodePublicationForSymbol({
    ...base, boards_json: JSON.stringify([{ symbol: 'ZEC', dir: 0, score: 60 }])
  }, 'ZEC');
  assert.equal(withheld.publicationState, 'withheld');
  assert.equal(associationFeatureBuckets({
    publicationState: 'published', publishedDirection: -1
  }).at(-1)[1], 'published-short');
});

test('publication lookup exhaustion is deferred, not persisted as unavailable', async () => {
  let calls = 0;
  const resolver = createPublicationResolver(async () => { calls++; return []; }, {}, {
    crypto: { first_at: '2025-01-01T00:00:00.000Z' }
  }, 0);
  const result = await resolver.resolve('crypto', 'ZEC', '2026-01-01');
  assert.deepEqual(result, { deferred: true, reason: 'publication-lookup-resource-cap' });
  assert.equal(calls, 0);
  const bars = barsFromCloses([100, 90, 65]);
  assert.equal(checkpointBeforeSignal(bars, utcDay(2)), utcDay(1));
});

test('bounded bar reads expose truncation and malformed rows before any checkpoint', () => {
  const rows = barsFromCloses([1, 2, 3]);
  assert.equal(boundedBarResult(rows, 2).truncated, true);
  const malformed = boundedBarResult([
    { date: '2026-09-01', close: 1, source: 'x' },
    { date: '2026-09-02', close: null, source: 'x' }
  ], 2);
  assert.equal(malformed.truncated, false);
  assert.equal(malformed.rejected, 1);
  assert.equal(boundedBarResult(barsFromCloses([1, 30]), 2).implausibleMoves, 1);
});

test('the truncation sentinel stays inside the physical bars-read budget', () => {
  assert.deepEqual(physicalBarReadPlan(2), { queryLimit: 2, usableAllowance: 1 });
  const result = physicalBarReadResult(barsFromCloses([1, 2, 3]), 2);
  assert.equal(result.rowsRead, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.bars.map((bar) => bar.close), [1]);
});

test('insufficient point-in-time history rotates safely until later bars arrive', () => {
  const sparse = barsFromCloses([100, 80, 70]);
  assert.equal(insufficientHistoryCheckpoint(sparse, utcDay(2), 4), utcDay(2));
  assert.equal(insufficientHistoryCheckpoint([], '2026-09-08', 4), '2026-09-08');
  assert.equal(insufficientHistoryCheckpoint(sparse, utcDay(2), 3), null);
});

test('migration and generated inserts enforce research-only multi-horizon state', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(migration);
    const episode = detectCrashRecoveryEpisodes(crossingFixture(), {
      lookbackSessions: 20, cooldownSessions: 20, horizonSessions: [365, 730]
    })[0];
    const meta = { asset_class: 'crypto', symbol: 'ZEC' };
    const publication = {
      publicationSnapshotAt: null, publicationState: 'unavailable',
      publishedDirection: null, publishedScore: null, publicationCallUsable: null,
      publicationAlignmentReason: 'unavailable:test-fixture'
    };
    const episodeStatement = episodeInsertStatement(
      meta, episode, publication, '2026-12-31', '2026-09-09T00:00:00.000Z'
    );
    assert.equal((episodeStatement.sql.match(/\?/g) || []).length, episodeStatement.params.length);
    database.prepare(episodeStatement.sql).run(...episodeStatement.params);
    for (const outcome of episode.outcomes) {
      const statement = outcomeUpsertStatement(
        meta, episode.signalDate, outcome, '2026-09-09T00:00:00.000Z'
      );
      assert.equal((statement.sql.match(/\?/g) || []).length, statement.params.length);
      database.prepare(statement.sql).run(...statement.params);
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM crash_recovery_outcomes').get().n, 2);
    assert.equal(database.prepare('SELECT evidence_partition FROM crash_recovery_episodes').get().evidence_partition,
      'bootstrap');
    assert.throws(() => database.prepare(`UPDATE crash_recovery_episodes
      SET live_edge_eligible=1`).run(), /constraint/i);
    assert.throws(() => database.prepare(`INSERT INTO crash_recovery_outcomes
      (asset_class,symbol,signal_date,method_version,horizon_sessions,
       outcome_status,observed_forward_sessions,first_recorded_at,updated_at)
      VALUES ('crypto','ZEC',?,'crash-recovery-pit-v1',252,'pending',0,'x','x')`)
      .run(episode.signalDate), /constraint/i);
  } finally {
    database.close();
  }
});

test('association SQL aggregates matured outcomes across partitions without double-counting', () => {
  const database = new DatabaseSync(':memory:');
  const nowIso = '2026-09-09T00:00:00.000Z';
  const publication = {
    publicationSnapshotAt: null, publicationState: 'unavailable',
    publishedDirection: null, publishedScore: null, publicationCallUsable: null,
    publicationAlignmentReason: 'unavailable:test-fixture'
  };
  const insert = ({ symbol, signalDate, eligibleAt, bootstrapThroughDate, cohortId,
    outcomeStatus, recoveredPriorPeak, first2xSessions = null, first5xSessions = null,
    forwardTerminalReturnPct = null, forwardMaxReturnPct = null,
    forwardMaxAdversePct = null }) => {
    const meta = { asset_class: 'crypto', symbol };
    const episode = {
      signalDate, eligibleAt, featureCutoffDate: signalDate, signalClose: 65,
      referenceEntryClose: 70, signalSource: 'fixture', entrySource: 'fixture',
      thresholdPct: -30, peakLookbackSessions: 252, trailingPeakClose: 100,
      drawdownPct: -35, peakAgeSessions: 10, trailingReturn20Pct: -30,
      realizedVol20Pct: 6, volumeRatio20: 1.5, distanceSma200Pct: -45,
      benchmarkSymbol: 'BTC', benchmarkReturn20Pct: -6,
      relativeStrength20Pct: -24, benchmarkRegime: 'down',
      depthBucket: '30-to-40', cohortId
    };
    const episodeStatement = episodeInsertStatement(
      meta, episode, publication, bootstrapThroughDate, nowIso
    );
    database.prepare(episodeStatement.sql).run(...episodeStatement.params);
    const matured = outcomeStatus === 'matured';
    const outcomeStatement = outcomeUpsertStatement(meta, signalDate, {
      horizonSessions: 365, outcomeStatus,
      observedForwardSessions: matured ? 365 : 12,
      outcomeLabel: matured
        ? recoveredPriorPeak ? 'recovered-prior-peak' : 'failed-recovery'
        : null,
      recoveredPriorPeak: matured ? recoveredPriorPeak : null,
      sessionsToRecovery: matured && recoveredPriorPeak ? 20 : null,
      first2xSessions: matured ? first2xSessions : null,
      first5xSessions: matured ? first5xSessions : null,
      first10xSessions: null, first20xSessions: null,
      forwardTerminalReturnPct: matured ? forwardTerminalReturnPct : null,
      forwardMaxReturnPct: matured ? forwardMaxReturnPct : null,
      forwardMaxAdversePct: matured ? forwardMaxAdversePct : null,
      hindsightLowClose: matured ? 55 : null,
      hindsightLowDate: matured ? eligibleAt : null,
      sessionsToHindsightLow: matured ? 0 : null,
      maturedAt: matured ? nowIso : null
    }, nowIso);
    database.prepare(outcomeStatement.sql).run(...outcomeStatement.params);
  };

  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(migration);
    insert({
      symbol: 'BTC', signalDate: '2020-01-01', eligibleAt: '2020-01-02',
      bootstrapThroughDate: '2020-03-31', cohortId: '2020-Q1',
      outcomeStatus: 'matured', recoveredPriorPeak: 1,
      first2xSessions: 10, first5xSessions: 50,
      forwardTerminalReturnPct: 100, forwardMaxReturnPct: 400,
      forwardMaxAdversePct: -20
    });
    insert({
      symbol: 'ETH', signalDate: '2020-02-01', eligibleAt: '2020-02-02',
      bootstrapThroughDate: '2020-03-31', cohortId: '2020-Q1',
      outcomeStatus: 'matured', recoveredPriorPeak: 0,
      forwardTerminalReturnPct: -50, forwardMaxReturnPct: 10,
      forwardMaxAdversePct: -60
    });
    insert({
      symbol: 'BTC', signalDate: '2020-04-01', eligibleAt: '2020-04-02',
      bootstrapThroughDate: '2020-03-31', cohortId: '2020-Q2',
      outcomeStatus: 'matured', recoveredPriorPeak: 1,
      first2xSessions: 40, forwardTerminalReturnPct: 25,
      forwardMaxReturnPct: 110, forwardMaxAdversePct: -15
    });
    insert({
      symbol: 'DOGE', signalDate: '2020-07-01', eligibleAt: '2020-07-02',
      bootstrapThroughDate: '2020-03-31', cohortId: '2020-Q3',
      outcomeStatus: 'pending', recoveredPriorPeak: null
    });

    const rows = database.prepare(associationAggregationSql('episode.depth_bucket'))
      .all('crash-recovery-pit-v1')
      .map((row) => ({ ...row }))
      .sort((a, b) => a.evidence_partition.localeCompare(b.evidence_partition));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => [
      row.evidence_partition, row.feature_bucket, row.n, row.unique_symbols,
      row.unique_cohorts, row.recovered_n, row.reached_2x_n, row.reached_5x_n
    ]), [
      ['all', '30-to-40', 3, 2, 2, 2, 2, 1],
      ['bootstrap', '30-to-40', 2, 2, 1, 1, 1, 1],
      ['prospective', '30-to-40', 1, 1, 1, 1, 1, 0]
    ]);
    const all = rows[0];
    assert.equal(all.avg_terminal_return_pct, 25);
    assert.ok(Math.abs(all.avg_max_return_pct - (520 / 3)) < 1e-12);
    assert.ok(Math.abs(all.avg_max_adverse_pct - (-95 / 3)) < 1e-12);
  } finally {
    database.close();
  }
});

test('schema labels forbid causal/live claims and omit iid confidence bounds', () => {
  assert.match(migration, /crash-threshold-crossing-not-bottom-or-cause/);
  assert.match(migration, /CHECK \(live_edge_eligible = 0\)/);
  assert.doesNotMatch(migration, /wilson_(lower|upper)|confidence_interval_(lower|upper)/i);
  const source = readFileSync(new URL(
    './scripts/crash-recovery-research.mjs', import.meta.url
  ), 'utf8');
  assert.doesNotMatch(source, /INSERT INTO (research_registry|signals|orders)|UPDATE\s+.*weight/i);
});
