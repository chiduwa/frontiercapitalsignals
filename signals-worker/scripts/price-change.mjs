// How this project measures and states a percentage change.
//
// Every alert it sends used to carry exactly one number, against an anchor the
// reader could not see. That is the defect this module exists to remove, and
// it produced a real, reported failure on 2026-09-14: BTW alerted "keeps
// rising, +4.1%" at 01:36 UTC while the asset was 7.0% below where it had been
// an hour earlier. Both facts were true. The alert reported the one that
// happened to suit its own five-minute window and said nothing about the
// window, so the reader had no way to tell which one they were being told.
//
// Three separate quantities get conflated whenever a move is squeezed into one
// number, and they are kept apart here on purpose:
//
//   1. POINT-TO-POINT CHANGE. "What is it worth now against what it was worth
//      at time T." Needs T stated or it means nothing. changeLadder().
//
//   2. EXCURSION. "How far is it from the best or worst price in a window."
//      Anchored to an extreme, not to a time, so it is always the flattering
//      number during a bounce and the alarming one during a pullback. It is
//      not interchangeable with (1). rangeContext().
//
//   3. PATH SHAPE. "Was that one move or a round trip." A 6% net change built
//      out of 40% of travel is a different event from a 6% one-way drift, and
//      no single percentage distinguishes them. pathEfficiency().
//
// The rule the rest of the system follows: never report a percentage without
// its anchor in the same sentence, and never let one horizon speak for a move
// when the horizons disagree.
//
// Pure functions, no I/O, no clock of its own, so callers pass `nowTs` and the
// same inputs always produce the same output.

// Shortest first. The rung a reader acts on is the fastest one, so it leads.
export const DEFAULT_HORIZONS_MIN = [15, 60, 360, 1440];

// How far off a horizon an anchor may sit before the rung stops claiming to be
// that horizon. A series sampled hourly cannot honestly answer "15 minutes
// ago"; it can answer "62 minutes ago", and saying so is the whole point.
export const DEFAULT_DRIFT_FRACTION = 0.34;

export function pctChange(from, to) {
  if (!(Number.isFinite(from) && Number.isFinite(to)) || from === 0) return null;
  return ((to / from) - 1) * 100;
}

// Normalises whatever the caller has into ascending {ts, price} with the junk
// dropped. Callers hold prices under a dozen different field names across this
// codebase and every one of them has to work here.
export function normaliseSeries(series) {
  const out = [];
  for (const s of series || []) {
    if (s == null) continue;
    const ts = Number(s.ts ?? s.time ?? (s.run_at != null ? Date.parse(s.run_at) : NaN));
    const price = Number(s.price ?? s.mark_price ?? s.close ?? s.cl ?? s.value);
    if (!Number.isFinite(ts) || !(price > 0)) continue;
    out.push({ ts, price });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Nearest sample to a target instant, with the miss distance reported rather
// than hidden. Linear scan from the back: these series are short and mostly
// the answer is near the end.
export function sampleAt(series, targetTs) {
  let best = null, bestDrift = Infinity;
  for (let i = series.length - 1; i >= 0; i--) {
    const drift = Math.abs(series[i].ts - targetTs);
    if (drift < bestDrift) { best = series[i]; bestDrift = drift; }
    else if (series[i].ts < targetTs - bestDrift) break;   // moving away, stop
  }
  return best ? { sample: best, driftMs: bestDrift } : null;
}

function minutesLabel(min) {
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${+(min / 60).toFixed(min % 60 === 0 ? 0 : 1)}h`;
  return `${+(min / 1440).toFixed(min % 1440 === 0 ? 0 : 1)}d`;
}

// The ladder. One rung per horizon, each carrying the anchor it actually used.
// A rung the series cannot support is returned with available:false instead of
// being silently dropped, so a caller can say "no 15-minute data" rather than
// letting the reader assume the fastest number shown is the fastest there is.
export function changeLadder(series, { nowTs, horizonsMin = DEFAULT_HORIZONS_MIN, driftFraction = DEFAULT_DRIFT_FRACTION } = {}) {
  const s = normaliseSeries(series);
  if (!s.length) return [];
  const now = Number.isFinite(nowTs) ? nowTs : s[s.length - 1].ts;
  const cur = sampleAt(s, now);
  if (!cur) return [];
  const price = cur.sample.price;

  return [...horizonsMin].sort((a, b) => a - b).map((min) => {
    const targetTs = now - min * 60000;
    const hit = sampleAt(s, targetTs);
    const tolerance = min * 60000 * driftFraction;
    if (!hit || hit.driftMs > tolerance || hit.sample.ts >= cur.sample.ts) {
      return { minutes: min, label: minutesLabel(min), available: false };
    }
    const actualMin = (cur.sample.ts - hit.sample.ts) / 60000;
    return {
      minutes: min,
      label: minutesLabel(min),
      available: true,
      anchorTs: hit.sample.ts,
      anchorPrice: hit.sample.price,
      price,
      pct: pctChange(hit.sample.price, price),
      // What the anchor really is, as distinct from what was asked for.
      actualMinutes: actualMin,
      exact: Math.abs(actualMin - min) <= Math.max(1, min * 0.05)
    };
  });
}

// Where the current price sits inside a window's range, and how far it is from
// each edge. `position` is 0 at the low and 1 at the high, which is the single
// number that answers "am I near the top or the bottom of this thing".
export function rangeContext(series, { nowTs, windowMin = 360 } = {}) {
  const s = normaliseSeries(series);
  if (!s.length) return null;
  const now = Number.isFinite(nowTs) ? nowTs : s[s.length - 1].ts;
  const win = s.filter((p) => p.ts >= now - windowMin * 60000 && p.ts <= now);
  if (win.length < 2) return null;
  let hi = win[0], lo = win[0];
  for (const p of win) { if (p.price > hi.price) hi = p; if (p.price < lo.price) lo = p; }
  const price = win[win.length - 1].price;
  const span = hi.price - lo.price;
  return {
    windowMin, samples: win.length, price,
    high: hi.price, highTs: hi.ts, low: lo.price, lowTs: lo.ts,
    fromHighPct: pctChange(hi.price, price),
    fromLowPct: pctChange(lo.price, price),
    rangePct: pctChange(lo.price, hi.price),
    position: span > 0 ? (price - lo.price) / span : null,
    // Which extreme came last says whether the window's story ends up or down,
    // and it is the piece a single percentage always loses.
    lastExtreme: hi.ts > lo.ts ? 'high' : 'low'
  };
}

// Kaufman's efficiency ratio: net distance covered divided by distance
// travelled. 1.0 is a straight line, 0.0 is a round trip that ended where it
// started. It is the cheapest available answer to "is this a trend or noise",
// and it is what separates GLM's +13% over six hours (a pump and a fade) from
// a +13% that actually went somewhere.
export function pathEfficiency(series, { nowTs, windowMin = 360 } = {}) {
  const s = normaliseSeries(series);
  if (!s.length) return null;
  const now = Number.isFinite(nowTs) ? nowTs : s[s.length - 1].ts;
  const win = s.filter((p) => p.ts >= now - windowMin * 60000 && p.ts <= now);
  if (win.length < 3) return null;
  const first = win[0].price, last = win[win.length - 1].price;
  let travelled = 0;
  for (let i = 1; i < win.length; i++) travelled += Math.abs(win[i].price - win[i - 1].price);
  if (!(travelled > 0) || !(first > 0)) return null;
  const net = last - first;
  return {
    windowMin, samples: win.length,
    netPct: pctChange(first, last),
    travelledPct: (travelled / first) * 100,
    ratio: Math.abs(net) / travelled,
    shape: describeShape(Math.abs(net) / travelled)
  };
}

// Cuts chosen to be readable rather than fitted. They label the number; no
// decision anywhere in this project is taken on the label.
export function describeShape(ratio) {
  if (!Number.isFinite(ratio)) return null;
  if (ratio >= 0.6) return 'one-way';
  if (ratio >= 0.3) return 'trending, with pullbacks';
  if (ratio >= 0.12) return 'choppy';
  return 'round trip';
}

// The whole picture, assembled once so every caller reports the same thing.
export function summarise(series, { nowTs, horizonsMin = DEFAULT_HORIZONS_MIN, rangeWindowMin = 360 } = {}) {
  const s = normaliseSeries(series);
  if (!s.length) return null;
  const now = Number.isFinite(nowTs) ? nowTs : s[s.length - 1].ts;
  const ladder = changeLadder(s, { nowTs: now, horizonsMin });
  const rungs = ladder.filter((r) => r.available && Number.isFinite(r.pct));
  if (!rungs.length) return null;

  const signs = new Set(rungs.map((r) => Math.sign(r.pct)).filter((x) => x !== 0));
  const fastest = rungs[0];

  return {
    price: fastest.price,
    nowTs: now,
    ladder,
    rungs,
    range: rangeContext(s, { nowTs: now, windowMin: rangeWindowMin }),
    path: pathEfficiency(s, { nowTs: now, windowMin: rangeWindowMin }),
    // The direction a reader would act on is the one on the shortest clock,
    // never the longest. The old alerts had this exactly backwards.
    direction: fastest.pct > 0 ? 'up' : fastest.pct < 0 ? 'down' : 'flat',
    directionHorizonMin: fastest.minutes,
    // When the horizons disagree, that disagreement IS the news, and a headline
    // that picks one of them is worse than one that admits the split.
    agreement: signs.size > 1 ? 'mixed' : 'aligned'
  };
}

const sign = (v) => (v > 0 ? '+' : '');

export function formatPct(v, dp = 1) {
  return Number.isFinite(v) ? `${sign(v)}${v.toFixed(dp)}%` : 'n/a';
}

export function formatPrice(v) {
  if (!Number.isFinite(v)) return 'n/a';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return v.toFixed(4);
  if (abs >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}

// The ladder as lines. Each one names its own anchor, which is the entire
// point, and a rung whose anchor drifted says so rather than pretending.
export function formatLadder(ladder) {
  return ladder.filter((r) => r.available).map((r) => {
    const drift = r.exact ? '' : ` (nearest data: ${minutesLabel(r.actualMinutes)} ago)`;
    return `  vs ${r.label} ago: ${formatPct(r.pct)}${drift}`;
  });
}

// One line that says where in the recent range the price currently sits.
export function formatRange(range) {
  if (!range) return null;
  const pos = Number.isFinite(range.position) ? `${Math.round(range.position * 100)}% of it` : 'n/a';
  return `Last ${minutesLabel(range.windowMin)} range: ${formatPrice(range.low)} to ${formatPrice(range.high)}, `
    + `now at ${pos} (${formatPct(range.fromHighPct)} from the high, ${formatPct(range.fromLowPct)} from the low).`;
}

// One line that says whether the net number above was a move or a round trip.
export function formatPath(path) {
  if (!path) return null;
  return `Path over ${minutesLabel(path.windowMin)}: ${formatPct(path.netPct)} net `
    + `while travelling ${path.travelledPct.toFixed(1)}%, so this looks ${path.shape}.`;
}

// The body every alert in this project should carry. Leads with the price and
// the fastest horizon, states every anchor, and never resolves a disagreement
// between horizons on the reader's behalf.
export function formatSummary(summary, { symbol = null } = {}) {
  if (!summary) return null;
  const lines = [];
  lines.push(`${symbol ? symbol + ' ' : ''}${formatPrice(summary.price)} now.`);
  lines.push(...formatLadder(summary.ladder));
  if (summary.agreement === 'mixed') {
    lines.push('  (these disagree: the move reversed inside the window, so pick the horizon you are trading.)');
  }
  const range = formatRange(summary.range);
  if (range) lines.push(range);
  const path = formatPath(summary.path);
  if (path) lines.push(path);
  return lines.join('\n');
}

// A headline that cannot claim a direction the fast clock does not support.
export function formatHeadline(summary, { symbol = '', noun = 'move' } = {}) {
  if (!summary) return `${symbol}: ${noun}`;
  const fast = summary.rungs[0];
  const dir = summary.direction === 'up' ? 'up' : summary.direction === 'down' ? 'down' : 'flat';
  const base = `${symbol}: ${formatPct(fast.pct)} in ${fast.label}`;
  return summary.agreement === 'mixed' ? `${base}, reversing` : `${base} and ${dir} across the board`;
}
