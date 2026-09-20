// Freeze the session/calendar timing rules so they can later be judged on data
// that did not exist when they were chosen.
//
// THE PROBLEM THIS SOLVES. Every timing figure on the dashboard is
// retrospective. session-research splits development (through 2025-12-31) from
// a 2026 "holdout", which was a clean split exactly once. The weekly rerun
// re-estimates on that same 2026 period, so each rerun inspects it again: the
// hours get re-picked with knowledge of how the last pick performed, and the
// word "holdout" slowly stops meaning anything. PREDICTION_ROADMAP.md names
// this directly — a rerun is monitoring, not independent confirmation — and
// says the fix is to timestamp every rule before its outcomes exist.
//
// So this script writes down, once, what today's rules ARE, and the date from
// which their outcomes count. Nothing here scores anything. Scoring a rule on
// the same run that proposed it is the whole disease; the cure has to be a
// separate pass over data that arrives later.
//
// WHY IT IS URGENT rather than merely important: prospective evidence can only
// be collected forward. Every day this does not run is a day of clean evidence
// that cannot be recovered afterwards at any price.
//
// WHY NOT research_registry. That table is the repo's existing frozen-hypothesis
// engine and it is good, but it is built for return-generating strategies —
// strategyMetrics, round-trip costs, a trade decision. Most rules here are
// ACTIVITY claims ("moves are larger around 10:00 ET"), which have no return
// and must never produce a side. Forcing them through a table whose vocabulary
// is profit would invite exactly the direction-from-magnitude inference the
// roadmap forbids. Directional rules stay separable via claim_type, and can be
// promoted into research_registry later on their own merits.
//
// Idempotent by construction: ON CONFLICT(rule_id) DO NOTHING. Re-running this
// can never move an existing freeze. If a later study picks a different hour,
// that is a different rule_id and a NEW row with its own later start date —
// which is what stops the goalposts moving without anyone noticing.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Usage: node scripts/session-freeze.mjs <session-report.json> [calendar-report.json]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { d1, chunk, forEachConcurrent } from './d1-client.mjs';

const env = {
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID
};

// A rule frozen today may not be scored on today. The study is computed from
// bars up to and including its own as-of date, so the first admissible outcome
// is the following day — anything earlier is training data wearing a new label.
export function evaluationStartFor(studyAsOf, frozenAt) {
  const asOfDay = String(studyAsOf || '').slice(0, 10);
  const frozenDay = String(frozenAt || '').slice(0, 10);
  // Whichever is LATER. A backfilled report must not buy itself an earlier
  // start date than the moment the freeze was actually recorded.
  const base = asOfDay > frozenDay ? asOfDay : frozenDay;
  const next = new Date(`${base}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// Every parameter that could change what the rule MEANS goes in the id. Two
// studies that pick different hours must not collide, or the later one would
// silently inherit the earlier one's start date and look prospective when it is
// not. Hours are sorted so that a reordering of an identical set is recognised
// as the same rule rather than a new one.
const hourKey = (hours) => (Array.isArray(hours) ? [...hours] : [])
  .map(Number).filter(Number.isFinite).sort((a, b) => a - b).join(',');

const norm = (s) => String(s ?? '').trim().replace(/\|/g, '/');

export function activityRuleId(symbol, profileName, hoursET) {
  return `session-activity|${norm(symbol)}|${norm(profileName)}|${hourKey(hoursET)}`;
}

export function morningRuleId(symbol, rule, condition) {
  return `session-morning|${norm(symbol)}|${norm(rule.window)}|${Number(rule.start)}-${Number(rule.end)}`
    + `|${norm(rule.target)}|${norm(condition.if)}`;
}

export function calendarRuleId(symbol, weekday, kind, hoursET) {
  return `calendar-weekday|${norm(symbol)}|${norm(weekday)}|${norm(kind)}|${hourKey(hoursET)}`;
}

const finite = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

// Pulls every candidate out of a session report, supported or not.
//
// Freezing only the rules the study liked would be a selection filter applied
// after seeing the results — the multiple-comparisons problem with extra steps,
// and it would make the family-wise correction the study already computed a
// lie. The unsupported ones are the control group; they cost one row each.
export function sessionReportFreezes(report, { frozenAt, runId = null } = {}) {
  if (!report || typeof report !== 'object') return [];
  const studyAsOf = report.asOf || null;
  const evaluationStartsAt = evaluationStartFor(studyAsOf, frozenAt);
  const common = {
    assetClass: 'crypto',
    frozenAt,
    evaluationStartsAt,
    studyVersion: report.version || 'unknown',
    studyAsOf,
    inputHash: report.inputHash || null,
    codeHash: report.codeHash || null,
    developmentEnds: report.developmentEnds || null,
    holdoutStarts: report.holdoutStarts || null,
    testsInFamily: finite(report.testFamilySize),
    firstSeenRun: runId
  };
  const out = [];
  for (const [symbol, asset] of Object.entries(report.assets || {})) {
    if (!asset || typeof asset !== 'object') continue;

    // --- activity: WHEN moves are larger. Never a direction. ---------------
    for (const [profileName, profile] of Object.entries(asset.profiles || {})) {
      const hours = profile && profile.selectedHoursET;
      if (!Array.isArray(hours) || !hours.length) continue;
      const evidence = profile.activityEvidence || {};
      out.push({
        ruleId: activityRuleId(symbol, profileName, hours),
        family: 'session-activity',
        claimType: 'activity',
        symbol,
        params: {
          profile: profileName,
          hoursET: [...hours].map(Number).sort((a, b) => a - b),
          instrument: asset.instrument || null,
          testDays: finite(profile.testDays)
        },
        discoveryN: finite(profile.testDays),
        discoveryStat: finite(evidence.mean ?? profile.activityUplift),
        discoveryAdjustedP: finite(evidence.adjustedP),
        // replicatedActivity is the study's own two-half agreement check.
        studySupported: profile.replicatedActivity === true,
        ...common
      });
    }

    // --- direction: conditional rules that do claim a side ------------------
    for (const rule of Array.isArray(asset.rules) ? asset.rules : []) {
      for (const condition of Array.isArray(rule.conditions) ? rule.conditions : []) {
        const net = condition.forwardNetEvidence || {};
        out.push({
          ruleId: morningRuleId(symbol, rule, condition),
          family: 'session-morning',
          claimType: 'direction',
          symbol,
          params: {
            window: rule.window || null,
            timezone: rule.timezone || null,
            startHourLocal: finite(rule.start),
            endHourLocal: finite(rule.end),
            target: rule.target || null,
            condition: condition.if || null,
            instrument: asset.instrument || null,
            // The claim being frozen, so a later reader does not have to
            // reconstruct it from whatever the study outputs by then.
            claimedForwardSameDirection: finite(condition.testForwardSameDirection)
          },
          discoveryN: finite(condition.testN),
          discoveryStat: finite(condition.testForwardSameDirection),
          discoveryAdjustedP: finite(net.adjustedP),
          studySupported: condition.supported === true,
          ...common
        });
      }
    }
  }
  return out;
}

// Calendar weekday extremes and jump/dump events. Same contract: every cell,
// not just the ones that passed.
export function calendarReportFreezes(report, { frozenAt, runId = null } = {}) {
  if (!report || typeof report !== 'object') return [];
  const studyAsOf = report.asOf || null;
  const common = {
    assetClass: 'crypto',
    frozenAt,
    evaluationStartsAt: evaluationStartFor(studyAsOf, frozenAt),
    studyVersion: report.version || 'unknown',
    studyAsOf,
    inputHash: report.inputHash || null,
    codeHash: report.codeHash || null,
    developmentEnds: report.developmentEnds || null,
    holdoutStarts: report.holdoutStarts || null,
    testsInFamily: finite(report.testFamilySize),
    firstSeenRun: runId
  };
  const out = [];
  for (const [symbol, asset] of Object.entries(report.assets || {})) {
    for (const day of Array.isArray(asset && asset.weekdays) ? asset.weekdays : []) {
      if (!day || day.status === 'insufficient-history') continue;
      for (const kind of ['peak', 'bottom']) {
        const cell = (day.extremes || {})[kind];
        const hours = cell && cell.hoursET;
        if (!Array.isArray(hours) || !hours.length) continue;
        out.push({
          ruleId: calendarRuleId(symbol, day.day, kind, hours),
          family: 'calendar-weekday',
          claimType: 'activity',
          symbol,
          params: { weekday: day.day, kind, hoursET: [...hours].map(Number).sort((a, b) => a - b) },
          discoveryN: finite(day.testN),
          discoveryStat: finite(cell.holdoutProbability && cell.holdoutProbability.mean),
          discoveryAdjustedP: finite(cell.adjustedP),
          studySupported: cell.weekdaySupported === true,
          ...common
        });
      }
    }
  }
  return out;
}

const ROW = (f) => [
  f.ruleId, f.family, f.claimType, f.assetClass, f.symbol, JSON.stringify(f.params ?? {}),
  f.frozenAt, f.evaluationStartsAt, f.studyVersion, f.studyAsOf, f.inputHash, f.codeHash,
  f.developmentEnds, f.holdoutStarts, f.discoveryN, f.discoveryStat, f.discoveryAdjustedP,
  f.testsInFamily, f.studySupported ? 1 : 0, f.firstSeenRun
];

export async function writeFreezes(freezes) {
  if (!freezes.length) return { attempted: 0, added: 0 };
  const before = await d1(env, 'SELECT COUNT(*) AS n FROM session_rule_freezes');
  await forEachConcurrent(chunk(freezes, 20), 3, async (batch) => {
    for (const f of batch) {
      // DO NOTHING, never DO UPDATE. An existing freeze is evidence about the
      // past and rewriting it would destroy the only thing this table is for.
      await d1(env, `
        INSERT INTO session_rule_freezes
          (rule_id, family, claim_type, asset_class, symbol, params_json,
           frozen_at, evaluation_starts_at, study_version, study_as_of,
           input_hash, code_hash, development_ends, holdout_starts,
           discovery_n, discovery_stat, discovery_adjusted_p, tests_in_family,
           study_supported, first_seen_run)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(rule_id) DO NOTHING`, ROW(f));
    }
  });
  const after = await d1(env, 'SELECT COUNT(*) AS n FROM session_rule_freezes');
  return { attempted: freezes.length, added: Number(after[0].n) - Number(before[0].n) };
}

async function main() {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.FCS_D1_DATABASE_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and FCS_D1_DATABASE_ID are required');
  }
  const [sessionPath, calendarPath] = process.argv.slice(2);
  if (!sessionPath) throw new Error('usage: session-freeze.mjs <session-report.json> [calendar-report.json]');
  const frozenAt = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID || null;

  const freezes = sessionReportFreezes(JSON.parse(readFileSync(sessionPath, 'utf8')), { frozenAt, runId });
  if (calendarPath) {
    freezes.push(...calendarReportFreezes(JSON.parse(readFileSync(calendarPath, 'utf8')), { frozenAt, runId }));
  }
  const byClaim = freezes.reduce((acc, f) => { acc[f.claimType] = (acc[f.claimType] || 0) + 1; return acc; }, {});
  console.log(`session-freeze: ${freezes.length} candidate rules (${JSON.stringify(byClaim)}) at ${frozenAt}`);

  const { attempted, added } = await writeFreezes(freezes);
  console.log(`session-freeze: ${added} newly frozen, ${attempted - added} already on record (unchanged)`);
  if (added > 0) {
    console.log(`session-freeze: evaluation starts ${freezes[0].evaluationStartsAt}; `
      + 'no outcome before that date may ever be used to score these rules.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(`[session-freeze] failed: ${e && e.stack || e}`); process.exit(1); });
}
