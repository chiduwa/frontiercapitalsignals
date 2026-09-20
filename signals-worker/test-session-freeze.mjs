// Guardrails for the prospective freeze.
//
// A freeze is only worth anything if two properties hold, and both fail
// SILENTLY when they break — the numbers just quietly get better:
//
//   1. Re-running never moves an existing freeze. If a rerun could update
//      frozen_at or evaluation_starts_at, every rule would permanently look
//      freshly minted and nothing would ever accumulate genuine out-of-sample
//      evidence.
//   2. Changing a rule changes its identity. If a study that re-picks 09:00
//      instead of 10:00 lands on the same rule_id, the new pick inherits the
//      old start date and its own training period is scored as prospective.
//
// Neither produces an error, a failed job, or a visible artefact. These tests
// are the only thing standing between the freeze and a very convincing lie.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activityRuleId, calendarRuleId, evaluationStartFor, morningRuleId,
  sessionReportFreezes, calendarReportFreezes
} from './scripts/session-freeze.mjs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  PASS  ${name}`); };

const FROZEN_AT = '2026-09-20T15:30:00.000Z';

// ---- evaluation start ------------------------------------------------------
test('a rule frozen today is never scored on today or earlier', () => {
  assert.equal(evaluationStartFor('2026-09-20', FROZEN_AT), '2026-09-21');
  // The study sees bars up to and including its own as-of date, so as-of day
  // itself is training data. Scoring it would be measuring the fit.
  assert.notEqual(evaluationStartFor('2026-09-20', FROZEN_AT), '2026-09-20');
});

test('a backfilled report cannot buy an earlier start than the freeze itself', () => {
  // Replaying an old report today must not let it claim a 2026-01 start date
  // and harvest eight months of "prospective" evidence it already saw.
  assert.equal(evaluationStartFor('2026-01-05', FROZEN_AT), '2026-09-21');
});

test('a study dated after the freeze still starts the day after the study', () => {
  assert.equal(evaluationStartFor('2026-10-02', FROZEN_AT), '2026-10-03');
});

test('month and year boundaries roll correctly', () => {
  assert.equal(evaluationStartFor('2026-12-31', '2026-12-31T00:00:00Z'), '2027-01-01');
  assert.equal(evaluationStartFor('2026-02-28', '2026-02-28T00:00:00Z'), '2026-03-01');
});

// ---- rule identity ---------------------------------------------------------
test('a different selected hour is a DIFFERENT rule', () => {
  assert.notEqual(activityRuleId('BTC', 'weekday', [9, 10, 11]),
                  activityRuleId('BTC', 'weekday', [8, 9, 10]));
});

test('the same hours in a different order are the SAME rule', () => {
  // Otherwise an unchanged rule would re-freeze every week and restart its own
  // evaluation window forever.
  assert.equal(activityRuleId('BTC', 'weekday', [10, 9, 11]),
               activityRuleId('BTC', 'weekday', [9, 10, 11]));
});

test('rule identity separates symbol, profile, weekday and kind', () => {
  assert.notEqual(activityRuleId('BTC', 'weekday', [9]), activityRuleId('ETH', 'weekday', [9]));
  assert.notEqual(activityRuleId('BTC', 'weekday', [9]), activityRuleId('BTC', 'weekend', [9]));
  assert.notEqual(calendarRuleId('BTC', 'Mon', 'peak', [9]), calendarRuleId('BTC', 'Tue', 'peak', [9]));
  assert.notEqual(calendarRuleId('BTC', 'Mon', 'peak', [9]), calendarRuleId('BTC', 'Mon', 'bottom', [9]));
});

test('a directional rule is identified by window, target and condition', () => {
  const rule = { window: 'NY midnight', start: 0, end: 2, target: 'next4h' };
  assert.notEqual(morningRuleId('BTC', rule, { if: 'up' }), morningRuleId('BTC', rule, { if: 'down' }));
  assert.notEqual(morningRuleId('BTC', rule, { if: 'up' }),
                  morningRuleId('BTC', { ...rule, target: 'close' }, { if: 'up' }));
  assert.notEqual(morningRuleId('BTC', rule, { if: 'up' }),
                  morningRuleId('BTC', { ...rule, end: 3 }, { if: 'up' }));
});

test('a pipe inside a parameter cannot forge a rule identity', () => {
  // rule_id is delimiter-joined, so an unescaped separator in a window name
  // could make two different rules collide.
  assert.notEqual(
    morningRuleId('BTC', { window: 'a|b', start: 0, end: 2, target: 't' }, { if: 'up' }),
    morningRuleId('BTC', { window: 'a', start: 0, end: 2, target: 'b|t' }, { if: 'up' })
  );
});

// ---- extraction against the real frozen report -----------------------------
const report = JSON.parse(readFileSync(new URL('./docs/release-2026-09-20/session-report.json', import.meta.url), 'utf8'));
const freezes = sessionReportFreezes(report, { frozenAt: FROZEN_AT, runId: 'test-run' });

test('the real September 20 report yields candidate rules', () => {
  assert.ok(freezes.length > 0, 'extractor found nothing in a real report');
});

test('rule ids are unique — no candidate silently overwrites another', () => {
  const ids = freezes.map((f) => f.ruleId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate rule_id would collapse two rules into one row');
});

test('unsupported candidates are frozen too, not just the winners', () => {
  // Freezing only what the study liked is a post-hoc selection filter, and it
  // would make the family-wise correction the study computed meaningless.
  const unsupported = freezes.filter((f) => !f.studySupported);
  assert.ok(unsupported.length > 0, 'the control group is missing');
});

test('activity rules never carry a direction', () => {
  for (const f of freezes.filter((f) => f.claimType === 'activity')) {
    const encoded = JSON.stringify(f.params);
    assert.ok(!/"(direction|side|bullish|bearish)"/.test(encoded),
      `activity rule ${f.ruleId} leaked a direction: ${encoded}`);
  }
});

test('every freeze carries the provenance needed to audit it later', () => {
  for (const f of freezes) {
    assert.ok(f.ruleId && f.family && f.symbol, 'identity');
    assert.ok(['direction', 'activity'].includes(f.claimType), `claim_type must be constrained: ${f.claimType}`);
    assert.equal(f.frozenAt, FROZEN_AT);
    assert.ok(f.evaluationStartsAt > String(f.studyAsOf), 'evaluation must start after the study as-of date');
    assert.ok(f.studyVersion && f.studyVersion !== 'unknown', 'study version');
    assert.ok(f.inputHash && f.codeHash, 'input/code hash pin the exact study that proposed this');
  }
});

test('both claim types are represented', () => {
  const kinds = new Set(freezes.map((f) => f.claimType));
  assert.ok(kinds.has('activity'), 'no activity rules extracted');
  assert.ok(kinds.has('direction'), 'no directional rules extracted');
});

test('extraction is deterministic — same report in, same rule ids out', () => {
  const again = sessionReportFreezes(report, { frozenAt: FROZEN_AT, runId: 'test-run' });
  assert.deepEqual(again.map((f) => f.ruleId), freezes.map((f) => f.ruleId));
});

test('a rerun that re-picks an hour produces a NEW rule, leaving the old frozen', () => {
  // The scenario the whole table exists for. Take a real activity rule, shift
  // its selected hour the way a weekly re-estimation would, and confirm the id
  // moves — so the old freeze survives untouched with its original start date.
  const mutated = JSON.parse(JSON.stringify(report));
  const symbol = Object.keys(mutated.assets)[0];
  const profile = mutated.assets[symbol].profiles.weekday;
  const originalId = activityRuleId(symbol, 'weekday', profile.selectedHoursET);
  profile.selectedHoursET = profile.selectedHoursET.map((h) => Number(h) + 1);
  const after = sessionReportFreezes(mutated, { frozenAt: '2026-09-27T15:30:00.000Z' });
  const ids = new Set(after.map((f) => f.ruleId));
  assert.ok(!ids.has(originalId), 'the re-picked rule must not reuse the original identity');
});

test('an empty or malformed report yields nothing rather than throwing', () => {
  assert.deepEqual(sessionReportFreezes(null, { frozenAt: FROZEN_AT }), []);
  assert.deepEqual(sessionReportFreezes({}, { frozenAt: FROZEN_AT }), []);
  assert.deepEqual(sessionReportFreezes({ assets: { BTC: null } }, { frozenAt: FROZEN_AT }), []);
  assert.deepEqual(calendarReportFreezes(null, { frozenAt: FROZEN_AT }), []);
});

// ---- the writer must never update ------------------------------------------
test('the writer inserts with DO NOTHING and never DO UPDATE', () => {
  const raw = readFileSync(new URL('./scripts/session-freeze.mjs', import.meta.url), 'utf8');
  // Strip line comments first. The prose in this file necessarily discusses
  // DO UPDATE in order to forbid it, and a scan that cannot tell code from
  // commentary fails on the explanation rather than on the behaviour.
  const code = raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(code.includes('ON CONFLICT(rule_id) DO NOTHING'),
    'a freeze must never be rewritten by a later run');
  assert.ok(!/DO\s+UPDATE/i.test(code),
    'DO UPDATE on this table would destroy the only thing it is for');
  assert.ok(!/UPDATE\s+session_rule_freezes/i.test(code), 'no UPDATE statement against the freeze ledger');
});

test('the migration constrains claim_type in the schema, not just in code', () => {
  const sql = readFileSync(new URL('./migrations/0046_session_rule_freezes.sql', import.meta.url), 'utf8');
  assert.ok(/claim_type TEXT NOT NULL CHECK\(claim_type IN \('direction','activity'\)\)/.test(sql),
    'an activity rule acquiring a direction must be rejected by the database');
  assert.ok(/rule_id TEXT PRIMARY KEY/.test(sql), 'rule_id must be the primary key for DO NOTHING to work');
});

console.log(`\n${passed} session-freeze tests passed`);
