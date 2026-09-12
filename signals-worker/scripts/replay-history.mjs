// Walk-forward replay of the confluence model over the permanent bar archive.
//
// WHY THIS EXISTS
//
// The publication gate needs CLASS_SKILL_MIN_SAMPLES (150) independent periods
// of matured composite outcomes before a class may show a direction, and
// loadDetailedCalibration counts an independent period as a distinct CALENDAR
// DAY. Accumulating that live takes 150 days at one forecast per symbol per
// day, minimum — and on 2026-09-12 the live ledger held 10 independent periods
// for crypto and 4 for stocks, because the loop had additionally deadlocked
// (see reliabilityMultiplierForAssetClass in worker.js).
//
// So the honest state of the engine was: "we cannot say whether this model has
// skill, and we will not be able to say for five months." That is not a
// threshold problem and lowering the bar would not fix it — it is a sample-size
// problem, and the samples already exist. asset_daily_bars holds 1.76M rows
// across 365 symbols. Replaying the model over them converts an unanswerable
// question into an answered one in a single run.
//
// This is NOT a way to make the model pass. The most likely outcome, given that
// no technique in the live library clears a per-day Fama-MacBeth test, is that
// the replay demonstrates the absence of skill far faster and far more
// convincingly than waiting would have. That is a good outcome: a negative
// result you can act on beats an open question you cannot.
//
// THE FOUR INTEGRITY RULES
//
// 1. NO LOOK-AHEAD. Metrics at anchor date D are built from bars[0..i] only
//    (replayMetrics enforces the slice). The reliability map used to weight the
//    panel at D contains only outcomes whose horizon had already ELAPSED by D —
//    maintained forward in time, never rebuilt from the finished ledger. The
//    forward bar is located by DATE and checked with spansExpectedDays, never
//    by index arithmetic: stepping i+7 across a gap produces a "7-day" return
//    spanning weeks, which is how a single +120,933% observation got into an
//    earlier validation run.
//
// 2. INDEPENDENCE. Stride equals the horizon, so two forecasts on the same
//    symbol and horizon never overlap. forecast_outcomes' primary key
//    (run_at, asset_class, symbol, horizon_minutes, series_kind, series_key)
//    enforces at most one per anchor, which is the v7 ledger contract that
//    replaced v6's habit of counting overlapping forecasts as independent
//    trials.
//
// 3. SAME MODEL. confluence(), evaluateTechniques() and compositeCall() are
//    imported from worker.js, not reimplemented. A replayed record that
//    measured a reimplementation would be measuring nothing.
//
// 4. SEPARABLE. Every row is written with provenance='replay' (migration 0038).
//    The loaders read both populations deliberately, but the column means any
//    query can compare them — and if replayed and live accuracy ever diverge
//    materially on the same model version, that divergence IS the alarm that
//    this harness has drifted.
//
// WHAT THE REPLAY CANNOT SEE
//
// Six techniques have no archived inputs and abstain throughout (valuation,
// attention, earnings, sentiment, impliedvol, positioning — see
// replay-metrics.mjs). Four more depend on ctx-supplied derived tables
// (leadlag, timeofday, seasonal cross-asset, mktoutlier) whose CURRENT values
// would be look-ahead at a past anchor and whose walk-forward reconstruction is
// its own project; they are left out rather than faked. The replayed composite
// is therefore a strict SUBSET of the live panel. That direction matters: a
// subset can only be less informed, so skill measured here is a lower bound on
// the live model, not an unrelated number. The per-technique vote census this
// prints on every run makes the actual coverage visible rather than assumed.
//
// Usage:
//   node scripts/replay-history.mjs --asset-class crypto --horizons 1,7
//   node scripts/replay-history.mjs --asset-class stock --budget 40000
//   node scripts/replay-history.mjs --reset            # clear checkpoints only
//   node scripts/replay-history.mjs --dry-run          # compute, write nothing

import { confluence, compositeCall, predictedRange, regimeOf } from '../worker.js';
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { loadBarQuarantine, cleanBars } from './bar-quarantine.mjs';
import { spansExpectedDays, loadFundamentalsPanel } from './cross-sectional.mjs';
import { replayMetrics, REPLAY_WARMUP_BARS } from './replay-metrics.mjs';
import {
  insertForecastOutcomes, OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION,
  WEIGHT_INDEPENDENT_MODEL_VERSIONS
} from './reliability.mjs';

const env = process.env;

// Mirrors OUTCOME_DEADBAND_PCT in reliability.mjs. A move smaller than this
// counts as FLAT, which marks an up-call and a down-call both wrong. It is not
// imported because that constant is module-private there; the duplication is
// asserted against live behaviour in test-replay.mjs so the two cannot drift.
const DEADBAND_PCT = 0.5;

const HORIZON_DAYS_TO_MINUTES = { 1: 1440, 7: 10080 };

// How many anchors between reliability-map folds. The map is advanced forward
// in time from the replay's own matured outcomes, so folding on every anchor
// would be exact but doubles the bookkeeping; folding every 7 anchors means the
// weights at a given anchor reflect evidence up to at most 7 days stale. Stale
// in the CONSERVATIVE direction — less information than the live model would
// have had — so it can only understate skill, never manufacture it.
const RELIABILITY_FOLD_EVERY = 7;

// A technique needs at least this many casts within a single period before that
// period yields an edge observation. Below it the period's hit rate is quantised
// too coarsely to mean anything — three casts can only score 0, 33, 67 or 100%,
// and that noise enters the t-test at full weight.
const TECHNIQUE_MIN_CASTS_PER_PERIOD = 8;

// Rows per run before stopping and checkpointing. The workflow ceiling is 120
// minutes and D1's REST round trip is ~330ms per request at 100 rows a request,
// so ~150k rows is roughly 8 minutes of writing plus the compute. Deliberately
// well inside the ceiling: a cancelled run wastes everything after the last
// checkpoint.
const DEFAULT_BUDGET = 150000;

// Bars to pull. The archive reaches back to 1970 for 16 long-history equities
// and ~2023 for most crypto; 2200 days covers the whole crypto universe and six
// years of equities without asking D1 for a result set it will time out on.
const DEFAULT_LOOKBACK_DAYS = 2200;

const ARCHIVE_SYMBOL_PAGE = 40;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const has = (name) => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// Same shape as cross-sectional.mjs's loadArchiveBars, but paged over a longer
// window and keeping the raw rows so the caller can group them once.
async function loadBars(assetClass, lookbackDays) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const symbolRows = await d1(env,
    `SELECT DISTINCT symbol FROM asset_daily_bars WHERE asset_class = ?1 AND date >= ?2 ORDER BY symbol`,
    [assetClass, since]);
  const symbols = symbolRows.map((r) => r.symbol);
  const bySymbol = new Map();
  for (const page of chunk(symbols, ARCHIVE_SYMBOL_PAGE)) {
    const placeholders = page.map((_, i) => `?${i + 3}`).join(',');
    const rows = await d1(env,
      `SELECT symbol, date, close, volume FROM asset_daily_bars
        WHERE asset_class = ?1 AND date >= ?2 AND close > 0 AND symbol IN (${placeholders})
        ORDER BY symbol, date`,
      [assetClass, since, ...page]);
    for (const r of rows) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
      bySymbol.get(r.symbol).push(r);
    }
  }
  // Quarantined bars are excluded from every fit for the reason migration 0034
  // documents: winsorising hides a corrupt print from a t-stat but not from an
  // indicator computed per symbol before any cross-section exists.
  const quarantine = await loadBarQuarantine(d1, env, { assetClass });
  const out = new Map();
  for (const [symbol, bars] of bySymbol) {
    const clean = cleanBars(quarantine, symbol, bars);
    if (clean.length >= REPLAY_WARMUP_BARS + 2) out.set(symbol, clean);
  }
  return out;
}

// Expanding percentile of each symbol's own open-interest history, which is
// what the live `openinterest` technique reads. Expanding, not rolling: see
// replayNonPriceMetrics for why the better statistic is the wrong one here.
// Strictly inclusive of the current value and nothing after it.
export function expandingOiPercentiles(derivBySymbol) {
  const out = new Map();
  for (const [symbol, byDate] of derivBySymbol) {
    const dates = [...byDate.keys()].sort();
    const seen = [];
    const perDate = new Map();
    for (const date of dates) {
      const v = byDate.get(date)?.oi_usd;
      if (!(v > 0)) { perDate.set(date, null); continue; }
      seen.push(v);
      let below = 0;
      for (const s of seen) if (s <= v) below++;
      perDate.set(date, below / seen.length);
    }
    out.set(symbol, perDate);
  }
  return out;
}

// Market cap by symbol and date, for crypto's turnover-based volRatio. Comes
// from asset_supply_daily, which carries market_cap alongside the derived
// circulating supply.
async function loadMarketCaps(assetClass) {
  if (assetClass !== 'crypto') return new Map();
  const rows = await d1(env,
    `SELECT symbol, date, market_cap FROM asset_supply_daily WHERE market_cap > 0 ORDER BY symbol, date`);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.symbol)) out.set(r.symbol, new Map());
    out.get(r.symbol).set(r.date, r.market_cap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Walk-forward reliability
// ---------------------------------------------------------------------------

// The map confluence() weights its panel with, advanced forward in time from
// the replay's OWN matured outcomes. Never rebuilt from the finished ledger —
// that would hand a 2023 anchor evidence from 2026.
//
// `pending` holds outcomes whose horizon has not elapsed as of the current
// anchor. fold() moves everything now matured into the live counters. This is
// the same maturity discipline evaluateMatured applies live, just driven by
// anchor dates instead of wall-clock time.
export function createWalkForwardReliability(seed = null) {
  const flat = seed ? { ...seed } : {};
  const pending = [];
  return {
    map: flat,
    add(row) {
      if (row.series_kind !== 'technique' || row.dir == null) return;
      pending.push(row);
    },
    // Folds every pending outcome whose target date is strictly before
    // `anchorDate` into the counters. Strictly: an outcome resolving ON the
    // anchor is not yet observable when the anchor's forecast is cast.
    fold(anchorDate) {
      let folded = 0;
      for (let k = pending.length - 1; k >= 0; k--) {
        const row = pending[k];
        if (!(row.targetDate < anchorDate)) continue;
        const key = `${row.symbol}|${row.series_key}`;
        const rec = (flat[key] ??= { correct: 0, total: 0, accuracy: 0, votes_up: 0, votes_down: 0 });
        rec.correct += row.correct ? 1 : 0;
        rec.total += 1;
        rec.accuracy = rec.correct / rec.total;
        if (row.dir === 1) rec.votes_up += 1;
        else if (row.dir === -1) rec.votes_down += 1;
        pending.splice(k, 1);
        folded++;
      }
      return folded;
    },
    pendingCount: () => pending.length
  };
}

// Direction baselines, also advanced forward. noSkillBaseline needs the
// realized up/flat/down mix for the class, and using today's mix at a 2023
// anchor is look-ahead in exactly the way that matters — the baseline is what
// every significance test is measured against.
export function createWalkForwardBaselines() {
  const counts = {};
  return {
    map: counts,
    observe(assetClass, horizonHours, actualDir) {
      for (const key of [`${assetClass}|${horizonHours}`, `${assetClass}|all`]) {
        const rec = (counts[key] ??= { n_up: 0, n_flat: 0, n_down: 0 });
        if (actualDir === 1) rec.n_up++;
        else if (actualDir === -1) rec.n_down++;
        else rec.n_flat++;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

// Calendar dates shared by the whole universe, stride = horizon, ascending.
// Calendar-anchored rather than per-symbol bar indices for the reason
// buildWeeklyCrossSections documents at length: every symbol in the archive has
// gaps, and walking back N bars per symbol lands each on a different day.
export function replayAnchors(barsBySymbol, horizonDays, { after = null, limit = null } = {}) {
  let minDate = '9999', maxDate = '';
  for (const bars of barsBySymbol.values()) {
    if (!bars.length) continue;
    if (bars[0].date < minDate) minDate = bars[0].date;
    if (bars[bars.length - 1].date > maxDate) maxDate = bars[bars.length - 1].date;
  }
  if (!maxDate || minDate === '9999') return [];
  // The first anchor must have REPLAY_WARMUP_BARS of history behind it and the
  // last must have the full horizon ahead of it, or it cannot be scored.
  const firstMs = Date.parse(`${minDate}T00:00:00Z`) + REPLAY_WARMUP_BARS * 86400000;
  const lastMs = Date.parse(`${maxDate}T00:00:00Z`) - horizonDays * 86400000;
  const startMs = after
    ? Math.max(firstMs, Date.parse(`${after}T00:00:00Z`) + horizonDays * 86400000)
    : firstMs;
  const anchors = [];
  for (let ms = startMs; ms <= lastMs; ms += horizonDays * 86400000) {
    anchors.push(new Date(ms).toISOString().slice(0, 10));
    if (limit && anchors.length >= limit) break;
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Scoring one anchor
// ---------------------------------------------------------------------------

// Locates the forward bar by DATE and validates the span. Returns null rather
// than guessing when the gap is too wide — an unscoreable forecast is dropped,
// never scored against whatever bar happened to be nearest.
export function forwardBar(bars, idx, i, anchorDate, horizonDays) {
  const targetDate = new Date(Date.parse(`${anchorDate}T00:00:00Z`) + horizonDays * 86400000)
    .toISOString().slice(0, 10);
  let j = idx.get(targetDate);
  if (j === undefined) {
    // Equities have no weekend bars, so the exact target often does not exist.
    // Take the first bar strictly after it and let spansExpectedDays judge.
    j = i + 1;
    while (j < bars.length && bars[j].date < targetDate) j++;
    if (j >= bars.length) return null;
  }
  if (!spansExpectedDays(bars[i].date, bars[j].date, horizonDays)) return null;
  return j;
}

export function directionOf(returnPct, deadband = DEADBAND_PCT) {
  return returnPct > deadband ? 1 : returnPct < -deadband ? -1 : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function replayClass(assetClass, horizonDaysList, { budget, dryRun, withTechniques, maxAnchors }) {
  console.log(`\n[replay] ${assetClass}: loading archive...`);
  const barsBySymbol = await loadBars(assetClass, Number(arg('lookback', DEFAULT_LOOKBACK_DAYS)));
  if (!barsBySymbol.size) {
    console.log(`[replay] ${assetClass}: no symbols with >= ${REPLAY_WARMUP_BARS} clean bars, nothing to do`);
    return { rows: 0 };
  }
  const extras = await loadFundamentalsPanel(env, assetClass, barsBySymbol);
  const oiExpanding = extras?.deriv ? expandingOiPercentiles(extras.deriv) : new Map();
  const marketCap = await loadMarketCaps(assetClass);
  const panel = { ...(extras || {}), oiExpanding, marketCap };

  // Benchmark for m.corr: the class's own reference asset, sliced to the anchor
  // by the caller at every use so it can never leak forward.
  const benchSymbol = assetClass === 'crypto' ? 'BTC' : 'SPY';
  const benchBars = barsBySymbol.get(benchSymbol) || null;
  const benchIdx = new Map();
  if (benchBars) for (let k = 0; k < benchBars.length; k++) benchIdx.set(benchBars[k].date, k);

  const idxBySymbol = new Map();
  for (const [symbol, bars] of barsBySymbol) {
    const idx = new Map();
    for (let k = 0; k < bars.length; k++) idx.set(bars[k].date, k);
    idxBySymbol.set(symbol, idx);
  }

  console.log(`[replay] ${assetClass}: ${barsBySymbol.size} symbols, `
    + `deriv ${extras?.deriv?.size ?? 0}, mcap ${marketCap.size}, bench ${benchSymbol}${benchBars ? '' : ' (absent)'}`);

  let totalRows = 0;
  const techniqueCensus = {};
  // technique -> one edge-over-baseline per period. This is the whole point of
  // the audit: the composite is known to have no edge, and this says whether
  // that is because every technique is dead or because a few live ones are
  // being drowned by twenty that are not.
  const techniqueEdges = {};

  for (const horizonDays of horizonDaysList) {
    const horizonMinutes = HORIZON_DAYS_TO_MINUTES[horizonDays];
    if (!horizonMinutes) throw new Error(`unsupported horizon ${horizonDays}d (live model logs 1d and 7d only)`);

    // A dry run is a MEASUREMENT, not a continuation, so it ignores the
    // checkpoint and walks the whole history. Resuming would confine the
    // per-technique audit to whatever anchors the last writing run happened to
    // leave over — which on a finished replay is the most recent few months,
    // i.e. one regime, sampled by an accident of budgeting.
    const checkpoint = dryRun ? null : await loadCheckpoint(assetClass, horizonDays);
    const anchors = replayAnchors(barsBySymbol, horizonDays, {
      after: checkpoint?.newest_anchor_done || null,
      limit: maxAnchors
    });
    if (!anchors.length) {
      console.log(`[replay] ${assetClass} ${horizonDays}d: caught up (through ${checkpoint?.newest_anchor_done || 'n/a'})`);
      continue;
    }
    console.log(`[replay] ${assetClass} ${horizonDays}d: ${anchors.length} anchors, `
      + `${anchors[0]} -> ${anchors[anchors.length - 1]}`);

    // Seed the walk-forward map from whatever this same replay already wrote in
    // an earlier run, so resuming is not the same as starting cold.
    const seed = checkpoint ? await loadReplaySeed(assetClass, horizonMinutes, anchors[0]) : null;
    const reliability = createWalkForwardReliability(seed);
    const baselines = createWalkForwardBaselines();

    let pendingRows = [];
    let anchorsDone = 0;
    let horizonRows = 0;
    // Set when the budget break above has already banked and zeroed
    // horizonRows, so the summary line reports the run instead of the counter.
    let budgetStopped = false;
    let bankedRows = 0;

    for (const anchor of anchors) {
      if (anchorsDone % RELIABILITY_FOLD_EVERY === 0) reliability.fold(anchor);

      const ctx = {
        directionBaselines: baselines.map,
        // Deliberately absent: marketContext, todStats, leadLagSignals,
        // leaderReturns, swingTimeStats, recentEvents, tvlSeries, srLevels,
        // srBreakStats, marketReturn, yieldSpreadChange, techniquePriors,
        // comboReliability, reliabilityByRegime. Every one of those is a
        // CURRENT derived value; handing it to a past anchor is look-ahead.
        // Their techniques abstain, which the census below makes visible.
        nowIso: `${anchor}T00:00:00.000Z`
      };
      const runAt = `${anchor}T00:00:00.000Z`;
      const evaluatedAt = new Date().toISOString();
      // technique -> { n, correct, up } for THIS anchor only.
      const periodTally = {};
      // This anchor's realized outcome mix, which is the null every technique
      // is judged against. Counted over the symbols actually scored here, not
      // borrowed from the class as a whole.
      let periodUp = 0, periodDown = 0, periodN = 0;

      for (const [symbol, bars] of barsBySymbol) {
        const idx = idxBySymbol.get(symbol);
        const i = idx.get(anchor);
        if (i === undefined || i < REPLAY_WARMUP_BARS - 1) continue;
        const j = forwardBar(bars, idx, i, anchor, horizonDays);
        if (j === null) continue;

        const entry = bars[i].close, exit = bars[j].close;
        if (!(entry > 0) || !(exit > 0)) continue;

        let benchCloses = null;
        if (benchBars) {
          const bi = benchIdx.get(anchor);
          if (bi !== undefined) benchCloses = benchBars.slice(0, bi + 1).map((b) => b.close);
        }

        const m = replayMetrics(symbol, bars, i, { kind: assetClass, extras: panel, benchCloses });
        if (!m) continue;

        const c = confluence(m, assetClass, reliability.map, ctx);
        if (!c || !c.total) continue;

        const returnPct = (exit / entry - 1) * 100;
        const actualDir = directionOf(returnPct);
        const regime = regimeOf(m.structure);
        const base = {
          run_at: runAt, asset_class: assetClass, symbol,
          horizon_minutes: horizonMinutes,
          actual_dir: actualDir, return_pct: returnPct,
          target_at: `${bars[j].date}T00:00:00.000Z`,
          observed_at: `${bars[j].date}T00:00:00.000Z`,
          entry_price: entry, exit_price: exit,
          evaluated_at: evaluatedAt,
          model_version: OUTCOME_MODEL_VERSION,
          label_version: OUTCOME_LABEL_VERSION,
          provenance: 'replay',
          // Folded into the rollup tables by refreshRollups() below, in bulk,
          // rather than one at a time through the incremental three-phase
          // commit. Every loader that feeds the model reads forecast_outcomes
          // directly and filters `aggregated = 1`, so a row left at 0 here
          // would be written, be correct, and be invisible.
          aggregated: 1
        };

        // The market row: what the price actually did, model-independent. This
        // is what direction_baseline is built from, and without it every
        // significance test downstream would be measured against a fair coin
        // in a class whose real no-skill line is nowhere near 0.5.
        pendingRows.push({ ...base, series_kind: 'market', series_key: 'market', dir: null, correct: 1 });
        baselines.observe(assetClass, horizonMinutes / 60, actualDir);
        periodN++;
        if (actualDir === 1) periodUp++; else if (actualDir === -1) periodDown++;

        for (const v of c.votes) {
          // Per-ANCHOR tally, not a running total. A technique's casts on one
          // date move together, so pooling them is the v6 independence error;
          // what the audit needs is one hit rate per period, alongside that
          // period's own outcome mix, so each period contributes a single
          // observation. Costs one object per technique per anchor and no D1
          // writes at all — the votes are computed either way to advance the
          // walk-forward map, so measuring them is free.
          const cell = (periodTally[v.id] ??= { n: 0, correct: 0, up: 0 });
          cell.n++;
          if (v.dir === actualDir) cell.correct++;
          if (v.dir === 1) cell.up++;
          techniqueCensus[v.id] = (techniqueCensus[v.id] || 0) + 1;
          const row = {
            ...base, series_kind: 'technique', series_key: v.id,
            dir: v.dir, regime, correct: v.dir === actualDir ? 1 : 0
          };
          // Fed to the walk-forward map regardless of whether the row is
          // persisted: the model's weights must evolve the way they would
          // live, even when --with-techniques is off and the rows are not kept.
          reliability.add({ ...row, targetDate: bars[j].date });
          if (withTechniques) pendingRows.push(row);
        }

        const cc = compositeCall(c);
        if (cc) {
          pendingRows.push({
            ...base, series_kind: 'technique', series_key: 'composite',
            dir: cc.dir, score: cc.score, regime,
            correct: cc.dir === actualDir ? 1 : 0
          });
          const r = predictedRange(entry, horizonDays, cc.score, cc.dir, null, symbol, m.volPct);
          if (r) {
            pendingRows.push({
              ...base, series_kind: 'range', series_key: 'range',
              dir: null, label_version: 'range-containment-v1',
              correct: (exit >= r.low && exit <= r.high) ? 1 : 0
            });
          }
        }
      }

      // Close the period: one edge observation per technique, against this
      // anchor's own no-skill line. A technique that cast fewer than
      // TECHNIQUE_MIN_CASTS_PER_PERIOD times here is dropped rather than
      // contributing a hit rate computed over two assets.
      if (periodN >= 10) {
        const pUp = periodUp / periodN, pDown = periodDown / periodN;
        for (const [id, cell] of Object.entries(periodTally)) {
          if (cell.n < TECHNIQUE_MIN_CASTS_PER_PERIOD) continue;
          const upFrac = cell.up / cell.n;
          const base = upFrac * pUp + (1 - upFrac) * pDown;
          (techniqueEdges[id] ??= []).push(cell.correct / cell.n - base);
        }
      }

      anchorsDone++;
      if (pendingRows.length >= 5000) {
        horizonRows += await flush(pendingRows, dryRun);
        pendingRows = [];
        if (totalRows + horizonRows >= budget) {
          console.log(`[replay] ${assetClass} ${horizonDays}d: budget reached at anchor ${anchor} (${horizonRows} rows this horizon)`);
          await saveCheckpoint(assetClass, horizonDays, anchor, anchorsDone, horizonRows, dryRun);
          totalRows += horizonRows;
          bankedRows = horizonRows;
          // Banked into totalRows and already checkpointed. Zeroed so the
          // summary below cannot add it a second time — and `budgetStopped`
          // exists because that summary previously read the zeroed counter and
          // reported "1632 anchors, 0 rows" on a run that had just written
          // 285,000 of them. Harmless to the data, actively misleading to
          // anyone reading the log to see whether a run did anything.
          horizonRows = 0;
          budgetStopped = true;
          break;
        }
      }
    }

    if (pendingRows.length) horizonRows += await flush(pendingRows, dryRun);
    if (horizonRows) {
      await saveCheckpoint(assetClass, horizonDays, anchors[Math.min(anchorsDone, anchors.length) - 1],
        anchorsDone, horizonRows, dryRun);
      totalRows += horizonRows;
    }
    console.log(`[replay] ${assetClass} ${horizonDays}d: ${anchorsDone} anchors, ${horizonRows + bankedRows} rows`
      + `${budgetStopped ? ' (stopped on budget — rerun to continue from the checkpoint)' : ''}`);
  }

  const census = Object.entries(techniqueCensus).sort((a, b) => b[1] - a[1]);
  console.log(`[replay] ${assetClass}: technique vote census (${census.length} of ~27 voted)`);
  for (const [id, n] of census) console.log(`           ${id.padEnd(14)} ${n}`);
  reportTechniqueSkill(assetClass, techniqueEdges, census.length);
  return { rows: totalRows };
}

// Per-technique Fama-MacBeth over the periods the replay just walked.
//
// THE QUESTION THIS ANSWERS: the composite has no edge. Is that because every
// technique is dead, or because a few live ones are outvoted by twenty that are
// not? Those imply opposite next steps — reweight, or delete the library and
// rebuild from the lanes that do measure something — and nothing else in the
// system distinguishes them, because the per-symbol reliability cells are far
// too thin to resolve a two-point effect.
//
// Bonferroni across the family. ~18 techniques are tested at once and the best
// one is read off the top, which is textbook manufacturing of a significant
// result out of noise; the same correction the cross-sectional lane applies to
// its feature search applies here for the same reason.
function reportTechniqueSkill(assetClass, edgesById, testedCount) {
  const ids = Object.keys(edgesById);
  if (!ids.length) return;
  const tests = Math.max(1, testedCount || ids.length);
  // Two-sided Bonferroni at family alpha 0.05, via the same normal-quantile
  // approximation bonferroniZ uses in cross-sectional.mjs.
  const alpha = 0.05 / tests / 2;
  const zBar = Math.abs(normalQuantile(alpha));
  const rows = [];
  for (const id of ids) {
    const e = edgesById[id];
    const k = e.length;
    if (k < 30) { rows.push({ id, periods: k, underpowered: true }); continue; }
    const mean = e.reduce((a, b) => a + b, 0) / k;
    const se = neweyWestSE(e);
    rows.push({
      id, periods: k, meanEdgePts: mean * 100,
      t: se ? mean / se : null,
      positive: e.filter((v) => v > 0).length,
      selected: se ? Math.abs(mean / se) >= zBar && mean > 0 : false
    });
  }
  rows.sort((a, b) => (b.meanEdgePts ?? -99) - (a.meanEdgePts ?? -99));
  console.log(`\n[replay] ${assetClass}: per-technique skill, one observation per period, Newey-West`);
  console.log(`           Bonferroni bar for ${tests} techniques: |t| >= ${zBar.toFixed(2)}`);
  console.log('           technique      periods   edge pts      NW t   periods +   verdict');
  for (const r of rows) {
    if (r.underpowered) {
      console.log(`           ${r.id.padEnd(14)} ${String(r.periods).padStart(7)}   (under 30 periods — not tested)`);
      continue;
    }
    const verdict = r.selected ? 'SELECTED' : (r.t != null && r.t <= -zBar ? 'anti-signal' : '');
    console.log(`           ${r.id.padEnd(14)} ${String(r.periods).padStart(7)} ${String(r.meanEdgePts.toFixed(2)).padStart(10)} ${String(r.t == null ? 'n/a' : r.t.toFixed(2)).padStart(9)} ${String(r.positive + '/' + r.periods).padStart(11)}   ${verdict}`);
  }
  const winners = rows.filter((r) => r.selected);
  console.log(winners.length
    ? `           ${winners.length} technique(s) clear the family bar: ${winners.map((r) => r.id).join(', ')}`
    : '           NOTHING clears the family bar — the library has no salvageable component at this horizon.');
}

// Bartlett-kernel standard error, same rule as replay-report.mjs. Duplicated
// rather than imported so the replay has no dependency on the reporting script.
function neweyWestSE(series) {
  const n = series.length;
  if (n < 3) return null;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const dev = series.map((v) => v - mean);
  const lag = Math.max(1, Math.floor(4 * Math.pow(n / 100, 2 / 9)));
  let s = dev.reduce((a, d) => a + d * d, 0) / n;
  for (let L = 1; L <= lag && L < n; L++) {
    let cov = 0;
    for (let t = L; t < n; t++) cov += dev[t] * dev[t - L];
    s += 2 * (1 - L / (lag + 1)) * (cov / n);
  }
  return s > 0 ? Math.sqrt(s / n) : null;
}

// Acklam's inverse normal CDF, accurate to ~1e-9 over the range that matters
// here. Same approximation cross-sectional.mjs uses for its own family bar.
function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) return -normalQuantile(1 - p);
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

async function flush(rows, dryRun) {
  if (!rows.length) return 0;
  if (dryRun) return rows.length;
  await insertForecastOutcomes(env, rows);
  return rows.length;
}

// Rebuilds the rollup mirrors wholesale from the ledger.
//
// The rollups (technique_reliability, range_reliability, direction_baseline,
// score_calibration*) are maintained incrementally during live runs — one
// three-phase commit per outcome, five statements each. That is right for a few
// hundred rows an hour and catastrophic for a few hundred thousand: it would
// add hours to the hourly build and hold the pending queue open the whole time.
//
// Recomputing them from forecast_outcomes with GROUP BY is both faster and
// strictly more correct, because it is IDEMPOTENT — it cannot double-count a
// retried batch the way an incremental increment can. Running it also makes the
// `aggregated = 1` the replay writes true rather than merely asserted.
//
// Note which model versions each mirror spans: the technique mirror follows
// WEIGHT_INDEPENDENT_MODEL_VERSIONS because a technique's own directional
// record is unaffected by the v7 -> v8 weighting change, while the composite-
// derived mirrors pin the active version only. Same split the loaders use.
export async function refreshRollups(dryRun = false) {
  if (dryRun) return;
  const now = new Date().toISOString();
  const versions = WEIGHT_INDEPENDENT_MODEL_VERSIONS;
  const statements = [
    {
      sql: `INSERT OR REPLACE INTO technique_reliability
              (asset_class, symbol, technique_id, horizon_hours, correct, total, accuracy, votes_up, votes_down, updated_at)
            SELECT asset_class, symbol, series_key, horizon_minutes / 60,
                   SUM(correct), COUNT(*), CAST(SUM(correct) AS REAL) / COUNT(*),
                   SUM(CASE WHEN dir = 1 THEN 1 ELSE 0 END),
                   SUM(CASE WHEN dir = -1 THEN 1 ELSE 0 END), ?3
              FROM forecast_outcomes
             WHERE series_kind = 'technique' AND aggregated = 1 AND dir IN (-1, 1)
               AND model_version IN (?1, ?2)
             GROUP BY asset_class, symbol, series_key, horizon_minutes`,
      params: [versions[0], versions[1], now]
    },
    {
      sql: `INSERT OR REPLACE INTO range_reliability
              (asset_class, symbol, horizon_hours, hits, total, accuracy, updated_at)
            SELECT asset_class, symbol, horizon_minutes / 60,
                   SUM(correct), COUNT(*), CAST(SUM(correct) AS REAL) / COUNT(*), ?2
              FROM forecast_outcomes
             WHERE series_kind = 'range' AND aggregated = 1 AND model_version = ?1
             GROUP BY asset_class, symbol, horizon_minutes`,
      params: [OUTCOME_MODEL_VERSION, now]
    },
    {
      sql: `INSERT OR REPLACE INTO direction_baseline
              (asset_class, horizon_hours, n_up, n_flat, n_down, updated_at)
            SELECT asset_class, horizon_minutes / 60,
                   SUM(CASE WHEN actual_dir = 1 THEN 1 ELSE 0 END),
                   SUM(CASE WHEN actual_dir = 0 THEN 1 ELSE 0 END),
                   SUM(CASE WHEN actual_dir = -1 THEN 1 ELSE 0 END), ?3
              FROM forecast_outcomes
             WHERE series_kind = 'market' AND aggregated = 1 AND model_version IN (?1, ?2)
             GROUP BY asset_class, horizon_minutes`,
      params: [versions[0], versions[1], now]
    },
    {
      sql: `INSERT OR REPLACE INTO score_calibration_detail
              (asset_class, dir, horizon_hours, bucket, correct, total, updated_at)
            SELECT asset_class, dir, horizon_minutes / 60,
                   MIN(9, MAX(0, CAST(score / 10 AS INTEGER))),
                   SUM(correct), COUNT(*), ?2
              FROM forecast_outcomes
             WHERE series_kind = 'technique' AND series_key = 'composite'
               AND aggregated = 1 AND score IS NOT NULL AND dir IN (-1, 1)
               AND model_version = ?1
             GROUP BY asset_class, dir, horizon_minutes,
                      MIN(9, MAX(0, CAST(score / 10 AS INTEGER)))`,
      params: [OUTCOME_MODEL_VERSION, now]
    },
    {
      sql: `INSERT OR REPLACE INTO score_calibration (bucket, correct, total, updated_at)
            SELECT MIN(9, MAX(0, CAST(score / 10 AS INTEGER))), SUM(correct), COUNT(*), ?2
              FROM forecast_outcomes
             WHERE series_kind = 'technique' AND series_key = 'composite'
               AND aggregated = 1 AND score IS NOT NULL AND dir IN (-1, 1)
               AND model_version = ?1
             GROUP BY MIN(9, MAX(0, CAST(score / 10 AS INTEGER)))`,
      params: [OUTCOME_MODEL_VERSION, now]
    }
  ];
  for (const st of statements) await d1(env, st.sql, st.params);
  console.log('[replay] rollup mirrors rebuilt from the ledger');
}

async function loadCheckpoint(assetClass, horizonDays) {
  const rows = await d1(env,
    `SELECT * FROM replay_checkpoints WHERE asset_class = ? AND horizon_days = ? AND model_version = ?`,
    [assetClass, horizonDays, OUTCOME_MODEL_VERSION]);
  return rows[0] || null;
}

async function saveCheckpoint(assetClass, horizonDays, newestAnchor, anchorsDone, rowsWritten, dryRun) {
  if (dryRun) return;
  await d1(env, `
    INSERT INTO replay_checkpoints
      (asset_class, horizon_days, oldest_anchor_done, newest_anchor_done, anchors_done, rows_written, model_version, last_run_at)
    VALUES (?1, ?2, COALESCE((SELECT oldest_anchor_done FROM replay_checkpoints WHERE asset_class=?1 AND horizon_days=?2 AND model_version=?7), ?4), ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(asset_class, horizon_days, model_version) DO UPDATE SET
      newest_anchor_done = excluded.newest_anchor_done,
      anchors_done = replay_checkpoints.anchors_done + excluded.anchors_done,
      rows_written = replay_checkpoints.rows_written + excluded.rows_written,
      last_run_at = excluded.last_run_at
  `, [assetClass, horizonDays, null, newestAnchor, anchorsDone, rowsWritten, OUTCOME_MODEL_VERSION, new Date().toISOString()]);
}

// Rebuilds the reliability counters from rows this replay already wrote, up to
// but NOT including the resume anchor. Only ever reads provenance='replay' rows
// whose horizon had elapsed before the anchor, so resuming lands on the same
// state the run would have held had it never stopped.
async function loadReplaySeed(assetClass, horizonMinutes, resumeAnchor) {
  const rows = await d1(env, `
    SELECT symbol, series_key,
           SUM(correct) AS correct, COUNT(*) AS total,
           SUM(CASE WHEN dir = 1 THEN 1 ELSE 0 END) AS votes_up,
           SUM(CASE WHEN dir = -1 THEN 1 ELSE 0 END) AS votes_down
      FROM forecast_outcomes
     WHERE provenance = 'replay' AND asset_class = ? AND horizon_minutes = ?
       AND series_kind = 'technique' AND series_key != 'composite'
       AND model_version = ? AND substr(target_at, 1, 10) < ?
     GROUP BY symbol, series_key
  `, [assetClass, horizonMinutes, OUTCOME_MODEL_VERSION, resumeAnchor]);
  const seed = {};
  for (const r of rows) {
    seed[`${r.symbol}|${r.series_key}`] = {
      correct: r.correct, total: r.total, accuracy: r.total ? r.correct / r.total : 0,
      votes_up: r.votes_up, votes_down: r.votes_down
    };
  }
  return seed;
}

async function main() {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN || !env.FCS_D1_DATABASE_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and FCS_D1_DATABASE_ID are required');
  }
  if (has('reset')) {
    await d1(env, `DELETE FROM replay_checkpoints WHERE model_version = ?`, [OUTCOME_MODEL_VERSION]);
    console.log('[replay] checkpoints cleared');
    return;
  }
  const classes = arg('asset-class') && arg('asset-class') !== true
    ? [String(arg('asset-class'))]
    : ['crypto', 'stock'];
  const horizons = String(arg('horizons', '1,7')).split(',').map((s) => Number(s.trim())).filter(Boolean);
  const budget = Number(arg('budget', DEFAULT_BUDGET));
  const maxAnchors = arg('max-anchors') ? Number(arg('max-anchors')) : null;
  const dryRun = has('dry-run');
  const withTechniques = has('with-techniques');

  console.log(`[replay] model=${OUTCOME_MODEL_VERSION} label=${OUTCOME_LABEL_VERSION} `
    + `classes=${classes.join(',')} horizons=${horizons.join(',')}d budget=${budget}`
    + `${withTechniques ? ' +per-technique rows' : ''}${dryRun ? ' DRY RUN' : ''}`);

  let total = 0;
  for (const assetClass of classes) {
    const { rows } = await replayClass(assetClass, horizons, { budget: budget - total, dryRun, withTechniques, maxAnchors });
    total += rows;
    if (total >= budget) { console.log('[replay] global budget reached'); break; }
  }
  if (total && !dryRun) await refreshRollups(dryRun);
  console.log(`\n[replay] done: ${total} outcome rows ${dryRun ? 'computed (not written)' : 'written'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[replay] failed:', e); process.exit(1); });
}
