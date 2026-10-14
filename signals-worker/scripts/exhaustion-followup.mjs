// One hour after an exhaustion alert: what the first hour did, and what has
// followed alerts that looked like this one at the same point (2026-10-14,
// docs/EXHAUSTION_FOLLOW_THROUGH.md).
//
// The owner asked whether volume that stays high after the alert means the
// coin keeps rising. Measured over every alert the current rules would have
// pushed, Jan 2023 - Oct 2026 with delisted coins included, it means the
// opposite: the hour after the alert still trading 20x its normal volume with
// the price at or above the alert close is when the squeeze risk is highest
// AND the eventual fall is largest. This push says which of three states the
// coin is in, with the numbers for that state. It is a description of past
// alerts, never a trade instruction.
//
// State, computed from the bars the scan already fetched:
//   vol1  quote volume of the hour after the alert / the alert's own 48h median
//         hourly volume (the baseline its 20x ratio was measured against)
//   held  that hour closed at or above the alert hour's close
//   hotHeld   vol1 >= 20 and held
//   hotFaded  vol1 >= 20, closed below
//   cooled    vol1 <  20 (5-20x held, 5-20x faded and <5x behaved alike)
import { surgeFeatures } from '../worker.js';
import { formatPct, formatPrice } from './price-change.mjs';
import { combinePushes } from './push-batch.mjs';

const HOUR = 3_600_000;
export const FOLLOWUP_HOT_VOLUME = 20;
// A follow-up later than this after the first hour closed describes an hour the
// reader has long since watched; it is recorded as late and not sent.
export const FOLLOWUP_MAX_LATE_MS = 90 * 60_000;

// docs/research-2026-10-14-exhaustion-followthrough/followup_evidence.py, every
// pushed alert (repeats included, as production pushes them). From the close of
// the hour after the alert: the highest high within 24 hours (median, 1-in-10,
// share reaching +8.7%, the distance a 10x short opened there is liquidated at in
// the owner's fills), the median return 3 days later and the share below.
// Spot hourly bars, not the futures mark price.
export const FOLLOWUP_EVIDENCE = Object.freeze({
  periods: ['2025-26', '2023-24'],
  hotHeld: [
    { n: 2434, share: 0.275, high24Median: 9.3, high24P90: 45.1, reach87: 0.52, ret72Median: -11.0, below72: 0.777 },
    { n: 2238, share: 0.249, high24Median: 8.2, high24P90: 37.2, reach87: 0.483, ret72Median: -8.9, below72: 0.759 }
  ],
  hotFaded: [
    { n: 3552, share: 0.401, high24Median: 6.5, high24P90: 36.8, reach87: 0.42, ret72Median: -7.0, below72: 0.743 },
    { n: 3578, share: 0.398, high24Median: 6.5, high24P90: 29.5, reach87: 0.406, ret72Median: -5.6, below72: 0.726 }
  ],
  cooled: [
    { n: 2861, share: 0.323, high24Median: 5.7, high24P90: 26.8, reach87: 0.367, ret72Median: -4.6, below72: 0.681 },
    { n: 3171, share: 0.353, high24Median: 5.9, high24P90: 27.8, reach87: 0.369, ret72Median: -3.1, below72: 0.639 }
  ]
});

const LABEL = {
  hotHeld: 'volume still hot, price held',
  hotFaded: 'volume still hot, price slipped',
  cooled: 'volume cooled'
};
const PRIORITY = { hotHeld: 'high', hotFaded: 'default', cooled: 'low' };

const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const pctRange = (a, b) => (Math.round(a * 100) === Math.round(b * 100) ? `${Math.round(a * 100)}%` : `${Math.round(a * 100)}% / ${Math.round(b * 100)}%`);
const numRange = (a, b, fmt) => (fmt(a) === fmt(b) ? fmt(a) : `${fmt(a)} / ${fmt(b)}`);

/**
 * The first hour after the alert bar that opened at castAt, or a reason it
 * cannot be read yet. bars: the scan's bars, oldest first, last one forming.
 */
export function followupState(bars, castAt, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(bars) || bars.length < 52) return { status: 'no-bars' };
  const a = ms(castAt);
  const i = bars.findIndex((b) => ms(b.openTime) === a);
  if (i < 0) return { status: 'no-bars' };
  const j = i + 1;
  if (j > bars.length - 2 || ms(bars[j].openTime) !== a + HOUR) return { status: 'not-due' };
  const closedAt = a + 2 * HOUR;
  if (nowMs - closedAt > FOLLOWUP_MAX_LATE_MS) return { status: 'late' };
  const f = surgeFeatures(bars, i, 48);
  if (!f || !(f.liquidity > 0) || !(bars[i].close > 0) || !(bars[j].close > 0)) return { status: 'no-bars' };
  const vol1 = bars[j].quoteVolume / f.liquidity;
  const move1Pct = (bars[j].close / bars[i].close - 1) * 100;
  const state = vol1 >= FOLLOWUP_HOT_VOLUME ? (move1Pct >= 0 ? 'hotHeld' : 'hotFaded') : 'cooled';
  return { status: 'due', state, vol1, move1Pct, alertClose: bars[i].close, price1: bars[j].close, now: bars[bars.length - 1].close };
}

export function evidenceSentence(state) {
  const [d, v] = FOLLOWUP_EVIDENCE[state];
  return `Past pushed alerts in this state (2025-26 / 2023-24, ${d.n.toLocaleString('en-US')} / ${v.n.toLocaleString('en-US')}): `
    + `over the next 24 hours the high reached 8.7% or more above the price at this point in ${pctRange(d.reach87, v.reach87)} of cases `
    + `(median high ${numRange(d.high24Median, v.high24Median, (x) => `+${x.toFixed(1)}%`)}, 1 in 10 went ${numRange(d.high24P90, v.high24P90, (x) => `+${Math.round(x)}%`)} or more), `
    + `and 3 days later the median was ${numRange(d.ret72Median, v.ret72Median, (x) => `${x.toFixed(1)}%`)}, below this price in ${pctRange(d.below72, v.below72)}.`;
}

const READ = {
  hotHeld: 'This is the state with the largest squeeze risk and the largest eventual fall. Volume staying high after the alert has not meant the coin keeps rising.',
  hotFaded: 'Squeeze risk is still above the cooled state; the fall has usually continued.',
  cooled: 'The quietest state: smaller squeezes and a slower, smaller fall.'
};

export function followupPush(symbol, s) {
  const line = `${symbol} ${formatPrice(s.now)}: ${LABEL[s.state]}. The hour after the alert traded ${s.vol1.toFixed(1)}x normal volume and closed ${formatPct(s.move1Pct)} vs the alert close. `
    + `Past: 24h high +8.7% or more in ${pctRange(FOLLOWUP_EVIDENCE[s.state][0].reach87, FOLLOWUP_EVIDENCE[s.state][1].reach87)}; 3-day median ${numRange(FOLLOWUP_EVIDENCE[s.state][0].ret72Median, FOLLOWUP_EVIDENCE[s.state][1].ret72Median, (x) => `${x.toFixed(1)}%`)}.`;
  const message = [
    `${symbol} ${formatPrice(s.now)} now, ${formatPct((s.now / s.alertClose - 1) * 100)} since the alert hour closed.`,
    `The hour after the alert traded ${s.vol1.toFixed(1)}x the coin's normal hourly volume (the 48h median the alert was measured against) and closed ${formatPct(s.move1Pct)} against the alert close, at ${formatPrice(s.price1)}.`,
    '',
    evidenceSentence(s.state),
    READ[s.state],
    '',
    'Highs are spot hourly bars, not the futures mark price. Historical frequencies, not the odds for this coin. Not a trade instruction. Not financial advice.'
  ].join('\n');
  return {
    symbol, state: s.state, line,
    push: { title: `${symbol}: 1h after the exhaustion alert, ${LABEL[s.state]}`, message, priority: PRIORITY[s.state], tags: ['hourglass'] }
  };
}

/**
 * Find pushed exhaustion alerts whose first hour has closed, send one batched
 * follow-up, and mark every one of them so no run sends it again. Late ones
 * are marked 'late' without a push. Alerts pushed in this same run are left
 * for the next run. query(env, sql, params) is d1().
 */
export async function runExhaustionFollowups({ env, query, barsBySymbol, nowMs = Date.now(), notify, dryRun = false, skip = new Set() }) {
  const since = new Date(nowMs - 6 * HOUR).toISOString();
  const rows = await query(env, `SELECT DISTINCT symbol, cast_at FROM surge_signal_log
    WHERE dir = -1 AND notified = 1 AND followup_at IS NULL AND cast_at >= ?`, [since]);
  const due = [];
  const late = [];
  for (const r of rows) {
    if (skip.has(JSON.stringify([r.symbol, r.cast_at]))) continue;
    const s = followupState(barsBySymbol[r.symbol], r.cast_at, { nowMs });
    if (s.status === 'due') due.push({ row: r, s, item: followupPush(r.symbol, s) });
    else if (s.status === 'late' || (s.status === 'no-bars' && nowMs - ms(r.cast_at) > 3 * HOUR)) late.push({ row: r, status: s.status });
  }
  const mark = async (r, state, s) => query(env, `UPDATE surge_signal_log SET followup_at = ?, followup_state = ?, followup_vol1 = ?, followup_move1_pct = ?
      WHERE symbol = ? AND cast_at = ? AND dir = -1`,
    [new Date(nowMs).toISOString(), state, s?.vol1 ?? null, s?.move1Pct ?? null, r.symbol, r.cast_at]);
  if (dryRun) {
    for (const d of due) console.log(`[dry run] follow-up ${d.row.symbol} ${d.row.cast_at}: ${d.s.state} (vol1 ${d.s.vol1.toFixed(1)}x, ${formatPct(d.s.move1Pct)})`);
    return { sent: 0, due: due.length, late: late.length };
  }
  for (const l of late) await mark(l.row, l.status === 'late' ? 'late' : 'unreadable', null);
  if (!due.length) return { sent: 0, due: 0, late: late.length };
  const order = { hotHeld: 0, hotFaded: 1, cooled: 2 };
  due.sort((a, b) => order[a.s.state] - order[b.s.state]);
  const push = combinePushes(due.map((d) => d.item), {
    noun: '1h after exhaustion',
    footer: 'Each line: what the hour after the alert did, and what followed past alerts in that state (2025-26 / 2023-24). Volume staying hot has meant a bigger squeeze and then a bigger fall, not a coin that keeps rising. Spot hourly highs. Not financial advice.'
  });
  if (!(await notify(push))) return { sent: 0, due: due.length, late: late.length };
  for (const d of due) await mark(d.row, d.s.state, d.s);
  return { sent: due.length, due: due.length, late: late.length };
}
