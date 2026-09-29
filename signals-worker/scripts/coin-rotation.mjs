// Coin rotation, on paper: the one real pattern the 2026-09-28 cadence study
// found (docs/CADENCE.md, sections 4 and 7). Coins mean-revert against the
// rest of the market: a coin that ran ahead of it over the last few days, or
// the last two months, tends to give some of it back. Replayed on the coins
// this log uses (the 100 most-traded on Binance), the 2-day version never
// paid after costs, and the 40-day version made about +34% and +32% a year in
// 2021-23 and 2024-26. But that replay only sees coins still listed today,
// which flatters buying laggards. The user asked for it to be logged live,
// with no money on it: a record with no such bias.
//
// Each UTC day, for each horizon k (2 and 40 days), over the 100 most-traded
// coins on Binance spot (median daily quote volume over 30 days; at least 41
// days of history; no stablecoins, gold or wrapped coins):
//   relative move = the coin's log move over the last k days, less the mean
//   of the other coins' moves over the same days
//   laggards (relative move < 0): the long leg; leaders (> 0): the short leg
// k days later the cohort is scored:
//   spread = the laggards' mean simple return less the leaders'
//   net    = spread less 0.2% (10 bps round trip on each leg, as on perps)
//   laggards vs market = the laggards' mean return less 0.2% (spot round
//   trip) less the whole universe's mean return: the long-only version
//
// Pure: nothing here touches the network or D1 (coin-rotation-io.mjs does).
// Dates are UTC calendar days ('YYYY-MM-DD'); a day's close is its last
// hourly close, so a daylight-saving change cannot move it.

export const ROTATION_VERSION = 'coin-rotation-v1';
export const ROT = Object.freeze({
  horizons: [2, 40],
  universeSize: 100,
  historyDays: 41,          // closes on each of the 41 days to the formation day: a 40-day look back
  volumeDays: 30,
  pegMedianMove: 0.003,     // median daily move under 0.3%: pegged, whatever it is called
  costSpread: 0.002,        // on the long-minus-short spread
  spotCost: 0.002,          // on the long leg alone
  minScored: 20,            // coins with an exit price before a cohort counts
  alertT: 2,                // a horizon's live record clears its costs at t >= 2 ...
  alertMinPeriods: 60,      // ... over at least this many non-overlapping periods (120 days at 2 days)
  alertMinPeriodsLong: 9,   // (360 days at 40 days)
  rearmT: 1,                // and is only announced again after falling back under t = 1
  // A one-day move beyond 100x is a ticker event, not a return: Binance
  // relaunched LUNA's pair as a new token (+177,000x on 2022-05-31), and SUN
  // and QUICK were redenominated 1,000 to 1. A coin with one inside its round
  // is left out of that round. (It also drops LUNA's real collapse, a 3,300x
  // fall, from the few rounds that held it: the conservative side.)
  breakMove: Math.log(100)
});
// Not coins in their own right: pegged to gold, or wrapped versions of another coin.
export const ROT_EXCLUDE = new Set(['PAXG', 'XAUT', 'WBTC', 'WBETH', 'BETH', 'STETH', 'WSTETH', 'BNSOL', 'CBBTC', 'WETH']);

const DAY = 86400000;
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// Daily closes and quote volumes from hourly bars ({ openTime, close,
// quoteVolume }). A day counts only once its last hour (23:00 UTC) has a bar.
export function dailyFromHourly(bars) {
  const close = new Map(), qv = new Map(), last = new Map();
  for (const b of bars || []) {
    const t = typeof b.openTime === 'number' ? b.openTime : Date.parse(b.openTime);
    if (!Number.isFinite(t) || !(b.close > 0)) continue;
    const d = new Date(t).toISOString().slice(0, 10);
    const h = new Date(t).getUTCHours();
    qv.set(d, (qv.get(d) || 0) + (Number.isFinite(b.quoteVolume) ? b.quoteVolume : 0));
    if (h >= (last.get(d) ?? -1)) { last.set(d, h); if (h === 23) close.set(d, b.close); }
  }
  for (const d of [...qv.keys()]) if (!close.has(d)) qv.delete(d);
  return { close, qv };
}

const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN;
};

// The universe on a formation day: dailyBySymbol maps symbol -> { close, qv }.
export function rotationUniverse(dailyBySymbol, formedOn) {
  const days = Array.from({ length: ROT.historyDays }, (_, i) => addDays(formedOn, i - ROT.historyDays + 1));
  const volDays = days.slice(-ROT.volumeDays);
  const cands = [];
  for (const [s, d] of Object.entries(dailyBySymbol)) {
    if (ROT_EXCLUDE.has(s)) continue;
    if (!days.every((x) => d.close.get(x) > 0)) continue;
    const moves = days.slice(1).map((x, i) => Math.abs(Math.log(d.close.get(x) / d.close.get(days[i]))));
    if (median(moves) < ROT.pegMedianMove) continue;
    cands.push([s, median(volDays.map((x) => d.qv.get(x)))]);
  }
  return cands.filter((c) => c[1] > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, ROT.universeSize).map((c) => c[0]);
}

// A cohort: each member's move over the last k days against the others'.
export function formCohort(dailyBySymbol, universe, formedOn, k) {
  const from = addDays(formedOn, -k);
  const moves = universe.map((s) => {
    const c1 = dailyBySymbol[s]?.close.get(formedOn), c0 = dailyBySymbol[s]?.close.get(from);
    return [s, c1 > 0 && c0 > 0 ? Math.log(c1 / c0) : NaN, c1];
  }).filter((m) => Number.isFinite(m[1]));
  const n = moves.length;
  if (n < ROT.minScored) return null;
  const total = moves.reduce((a, m) => a + m[1], 0);
  const rel = moves.map(([s, m, c]) => [s, c, m - (total - m) / (n - 1)]);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return {
    formedOn, horizon: k, maturesOn: addDays(formedOn, k), universeN: n,
    longs: rel.filter((x) => x[2] < 0).sort((a, b) => a[2] - b[2]).map(([s, c, r]) => [s, c, r6(r)]),
    shorts: rel.filter((x) => x[2] > 0).sort((a, b) => b[2] - a[2]).map(([s, c, r]) => [s, c, r6(r)])
  };
}

// Scores a cohort once its k days have passed. exitClose(symbol) -> close on
// the maturity day, or null (a coin that stopped trading drops out of both
// the leg and the universe). broken(symbol) -> true when the coin's round
// held a ticker event (breakInWindow); it drops out the same way.
export function scoreCohort(cohort, exitClose, { broken = () => false } = {}) {
  const leg = (members) => members.map(([s, entry]) => {
    if (broken(s)) return null;
    const x = exitClose(s);
    return x > 0 && entry > 0 ? x / entry - 1 : null;
  }).filter((r) => r != null);
  const L = leg(cohort.longs), S = leg(cohort.shorts);
  if (L.length + S.length < ROT.minScored || !L.length || !S.length) return null;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const longRet = mean(L), shortRet = mean(S), universeRet = mean([...L, ...S]);
  const spread = longRet - shortRet;
  return {
    longRet, shortRet, spread, netSpread: spread - ROT.costSpread,
    universeRet, laggardsExcess: longRet - ROT.spotCost - universeRet, nScored: L.length + S.length
  };
}

// Whether a coin's daily closes between two days (exclusive, inclusive) hold a
// one-day move beyond ROT.breakMove.
export function breakInWindow(close, fromDay, toDay) {
  let prev = close.get(fromDay);
  for (let d = addDays(fromDay, 1); d <= toDay; d = addDays(d, 1)) {
    const c = close.get(d);
    if (c > 0 && prev > 0 && Math.abs(Math.log(c / prev)) > ROT.breakMove) return true;
    if (c > 0) prev = c;
  }
  return false;
}

// Mean and Newey-West t (lag k-1: daily cohorts over k days overlap) of a series.
export function neweyWestT(xs, lag) {
  const n = xs.length;
  if (n < 3) return null;
  const mu = xs.reduce((a, b) => a + b, 0) / n;
  const d = xs.map((x) => x - mu);
  let v = d.reduce((a, b) => a + b * b, 0) / n;
  for (let l = 1; l <= Math.min(lag, n - 1); l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += d[i] * d[i - l];
    v += 2 * (1 - l / (lag + 1)) * (g / n);
  }
  return v > 0 ? mu / Math.sqrt(v / n) : null;
}

// A horizon's live record from its scored cohorts ({ formed_on, net_spread,
// laggards_excess }), oldest first.
export function rotationRecord(scored, k) {
  const rows = (scored || []).filter((r) => Number.isFinite(r.net_spread));
  const net = rows.map((r) => r.net_spread), lag = rows.map((r) => r.laggards_excess).filter(Number.isFinite);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const m = mean(net);
  return {
    horizon: k, cohorts: rows.length, periods: Math.floor(rows.length / k),
    since: rows.length ? rows[0].formed_on : null,
    netPerCohort: m, netPerYear: m == null ? null : m * 365 / k, t: neweyWestT(net, k - 1),
    laggardsPerCohort: mean(lag), laggardsPerYear: mean(lag) == null ? null : mean(lag) * 365 / k, laggardsT: neweyWestT(lag, k - 1)
  };
}

// Whether a horizon is "paying" on its live record, with hysteresis so one
// good or bad day does not flip it back and forth.
export function rotationAlertState(record, prev = 'not') {
  const minPeriods = record.horizon <= 2 ? ROT.alertMinPeriods : ROT.alertMinPeriodsLong;
  const clears = record.t != null && record.t >= ROT.alertT && record.netPerCohort > 0 && record.periods >= minPeriods;
  if (prev === 'paying') return record.t != null && record.t < ROT.rearmT ? 'not' : 'paying';
  return clears ? 'paying' : 'not';
}

export function rotationAlert(record) {
  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
  return {
    title: `Coin rotation (${record.horizon}-day) is clearing its costs on paper`,
    message: `Since ${record.since}, holding the coins that lagged the market over ${record.horizon} days against the ones that led `
      + `made ${pct(record.netPerCohort)} per ${record.horizon}-day round after 0.2% costs (about ${pct(record.netPerYear)} a year), `
      + `t = ${record.t.toFixed(2)} over ${record.cohorts} daily rounds. On paper only: nothing was traded. `
      + 'The 2021-26 replay only saw coins still listed today, which flatters holding laggards; this live record does not. '
      + 'A reason to look, not to trade. Not financial advice.'
  };
}
