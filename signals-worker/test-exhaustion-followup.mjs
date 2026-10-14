import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  followupState, followupPush, runExhaustionFollowups, evidenceSentence,
  FOLLOWUP_EVIDENCE, FOLLOWUP_MAX_LATE_MS
} from './scripts/exhaustion-followup.mjs';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-14T00:00:00.000Z');

// 60 hourly bars at $1,000/h, the alert at index 50, the first hour after it at
// 51; bars.length - 1 is the forming bar.
function makeBars({ alertQv = 30_000, nextQv = 25_000, nextClose = 1.12, forming = 52 } = {}) {
  const bars = [];
  for (let i = 0; i <= forming; i++) {
    let open = 1, close = 1, qv = 1_000;
    if (i === 50) { open = 1; close = 1.1; qv = alertQv; }
    if (i === 51) { open = 1.1; close = nextClose; qv = nextQv; }
    if (i > 51) { open = nextClose; close = nextClose; }
    bars.push({ openTime: new Date(T0 + i * HOUR).toISOString(), open, high: Math.max(open, close), low: Math.min(open, close), close, quoteVolume: qv, trades: 100 });
  }
  return bars;
}
const castAt = new Date(T0 + 50 * HOUR).toISOString();
const firstHourClosed = T0 + 52 * HOUR;

test('classifies the first hour after the alert against the alert baseline', () => {
  const s = followupState(makeBars(), castAt, { nowMs: firstHourClosed + 5 * 60_000 });
  assert.equal(s.status, 'due');
  assert.equal(s.state, 'hotHeld');
  assert.equal(Math.round(s.vol1), 25);
  assert.ok(Math.abs(s.move1Pct - (1.12 / 1.1 - 1) * 100) < 1e-9);
  assert.equal(followupState(makeBars({ nextClose: 1.05 }), castAt, { nowMs: firstHourClosed }).state, 'hotFaded');
  assert.equal(followupState(makeBars({ nextQv: 19_000 }), castAt, { nowMs: firstHourClosed }).state, 'cooled');
});

test('waits for the first hour to close, and does not send a stale one', () => {
  assert.equal(followupState(makeBars({ forming: 51 }), castAt, { nowMs: T0 + 51.5 * HOUR }).status, 'not-due');
  assert.equal(followupState(makeBars(), castAt, { nowMs: firstHourClosed + FOLLOWUP_MAX_LATE_MS + 1 }).status, 'late');
  assert.equal(followupState(makeBars(), '2026-10-01T00:00:00.000Z', { nowMs: firstHourClosed }).status, 'no-bars');
});

function memoryDb(rows) {
  const updates = [];
  const query = async (_env, sql, params) => {
    if (/^SELECT/.test(sql)) {
      assert.match(sql, /followup_at IS NULL/);
      return rows.filter((r) => !r.followup_at && r.cast_at >= params[0]).map(({ symbol, cast_at }) => ({ symbol, cast_at }));
    }
    assert.match(sql, /^UPDATE surge_signal_log SET followup_at/);
    const [at, state, , , symbol, cast] = params;
    updates.push({ symbol, cast, state });
    for (const r of rows) if (r.symbol === symbol && r.cast_at === cast) { r.followup_at = at; r.followup_state = state; }
    return [];
  };
  return { query, updates, rows };
}

test('one batched push, rows marked only after acceptance, never sent twice', async () => {
  const bars = { AAA: makeBars(), BBB: makeBars({ nextQv: 5_000, nextClose: 1.0 }) };
  const db = memoryDb([{ symbol: 'AAA', cast_at: castAt }, { symbol: 'BBB', cast_at: castAt }]);
  const sent = [];
  let accept = false;
  const notify = async (p) => { sent.push(p); return accept; };
  const opts = { env: {}, query: db.query, barsBySymbol: bars, nowMs: firstHourClosed + 5 * 60_000, notify };
  let r = await runExhaustionFollowups(opts);
  assert.equal(r.sent, 0);
  assert.equal(db.updates.length, 0, 'a rejected push leaves both retryable');
  accept = true;
  r = await runExhaustionFollowups(opts);
  assert.equal(r.sent, 2);
  assert.equal(sent.length, 2);
  const push = sent[1];
  assert.match(push.title, /AAA, BBB/);
  assert.equal(push.priority, 'high', 'the hot-and-held coin sets the batch priority');
  assert.ok(push.message.indexOf('AAA') < push.message.indexOf('BBB'), 'hot-and-held first');
  assert.deepEqual(db.updates.map((u) => [u.symbol, u.state]).sort(), [['AAA', 'hotHeld'], ['BBB', 'cooled']]);
  r = await runExhaustionFollowups(opts);
  assert.equal(r.due, 0);
  assert.equal(sent.length, 2);
});

test('late alerts are marked without a push; alerts pushed this run are left alone', async () => {
  const db = memoryDb([{ symbol: 'AAA', cast_at: castAt }, { symbol: 'CCC', cast_at: castAt }]);
  const sent = [];
  const r = await runExhaustionFollowups({
    env: {}, query: db.query, barsBySymbol: { AAA: makeBars(), CCC: makeBars() },
    nowMs: firstHourClosed + FOLLOWUP_MAX_LATE_MS + 60_000, notify: async (p) => { sent.push(p); return true; },
    skip: new Set([JSON.stringify(['CCC', castAt])])
  });
  assert.equal(sent.length, 0);
  assert.equal(r.late, 1);
  assert.deepEqual(db.updates.map((u) => [u.symbol, u.state]), [['AAA', 'late']]);
});

test('a single follow-up reads as a full message with both periods', () => {
  const s = followupState(makeBars(), castAt, { nowMs: firstHourClosed });
  const item = followupPush('AAA', s);
  assert.match(item.push.message, /25\.0x the coin's normal hourly volume/);
  assert.match(item.push.message, /52% \/ 48%/);
  assert.match(item.push.message, /-11\.0% \/ -8\.9%/);
  assert.match(item.push.message, /Not a trade instruction/);
  assert.ok(new TextEncoder().encode(item.push.message).length < 3800);
  for (const st of ['hotHeld', 'hotFaded', 'cooled']) assert.match(evidenceSentence(st), /2025-26 \/ 2023-24/);
});

test('quoted evidence is exactly the research output', () => {
  const ev = JSON.parse(readFileSync(new URL('./docs/research-2026-10-14-exhaustion-followthrough/followup_evidence.json', import.meta.url)));
  for (const st of ['hotHeld', 'hotFaded', 'cooled']) {
    ['disc', 'val'].forEach((per, i) => {
      for (const k of ['n', 'share', 'high24Median', 'high24P90', 'reach87', 'ret72Median', 'below72']) {
        assert.equal(FOLLOWUP_EVIDENCE[st][i][k], ev[st][per][k], `${st} ${per} ${k}`);
      }
    });
  }
});
