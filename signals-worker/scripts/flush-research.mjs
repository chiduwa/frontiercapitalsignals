// What separates a liquidation flush that rebounds from a real decline that
// keeps going?
//
// Motivating case: WLFI 2026-09-11 10:15 UTC fell 16.45% in under five minutes
// on 56x normal volume and recovered 57% of it within half an hour. A stop or
// a leveraged long placed anywhere near the pre-flush price is taken out by
// that move and then watches the rebound. The trader was right about direction
// and still lost.
//
// The hypothesis under test is mechanical, not sentimental. A cascade is FORCED
// selling: leveraged positions are closed by the exchange, which CLOSES open
// interest. Informed selling is new positioning, which OPENS it. So:
//
//   price down + open interest DOWN  -> positions being liquidated out.
//                                       Supply is exhausting itself and the
//                                       move should be self-limiting.
//   price down + open interest UP    -> new shorts entering with conviction.
//                                       Nothing is exhausting; the move can run.
//
// If that holds, the depth of a flush is partly PREDICTABLE, and the right
// response is not a wider stop but an entry placed at the flush low.
//
// Data: 1-minute klines and 5-minute OI/positioning metrics from Binance's
// public data portal (global, not US — the live API is geo-blocked from here,
// the portal is not). Read-only; writes nothing to the live model.
import { unzipSingleFile, venueSymbol } from './derivatives-archive.mjs';

// A flush is a drop of at least this much, measured from the highest high of
// the preceding 5 minutes to the lowest low of the next 5.
export const FLUSH_DROP_PCT = -6;
export const FLUSH_WINDOW_MIN = 5;
// How far forward "did it come back" is measured.
export const RECOVERY_WINDOW_MIN = 30;
// Volume baseline: the hour before the event.
export const BASELINE_MIN = 60;

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

async function portalCsv(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return unzipSingleFile(Buffer.from(await r.arrayBuffer()));
}

export async function fetchMinuteBars(venue, date) {
  const csv = await portalCsv(
    `https://data.binance.vision/data/futures/um/daily/klines/${venue}/1m/${venue}-1m-${date}.zip`);
  if (!csv) return null;
  const out = [];
  for (const line of csv.trim().split('\n')) {
    const f = line.split(',');
    const t = Number(f[0]);
    if (!Number.isFinite(t)) continue;
    out.push({
      t, o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5],
      trades: +f[8], takerBuyBase: +f[9]
    });
  }
  return out.length ? out : null;
}

// 5-minute open interest for one day, as [{t, oiUsd}].
export async function fetchMinuteOi(venue, date) {
  const csv = await portalCsv(
    `https://data.binance.vision/data/futures/um/daily/metrics/${venue}/${venue}-metrics-${date}.zip`);
  if (!csv) return null;
  const lines = csv.trim().split('\n');
  const head = lines[0].split(',').map((h) => h.trim());
  const ci = Object.fromEntries(head.map((h, i) => [h, i]));
  if (!('create_time' in ci) || !('sum_open_interest_value' in ci)) return null;
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const t = Date.parse(`${(f[ci.create_time] || '').trim().replace(' ', 'T')}Z`);
    const oi = Number(f[ci.sum_open_interest_value]);
    if (!Number.isFinite(t) || !(oi > 0)) continue;
    out.push({ t, oiUsd: oi });
  }
  return out.length ? out : null;
}

// Nearest OI reading at or before `t`, and at or after `t + minutes`.
function oiAcross(oiSeries, t, minutes) {
  if (!oiSeries) return null;
  const end = t + minutes * 60000;
  let before = null, after = null;
  for (const p of oiSeries) {
    if (p.t <= t) before = p;
    if (p.t >= end && after === null) after = p;
  }
  if (!before || !after || !(before.oiUsd > 0)) return null;
  return { pct: ((after.oiUsd / before.oiUsd) - 1) * 100, from: before.oiUsd, to: after.oiUsd };
}

// Realized volatility (stdev of 1-minute log returns, in %) over a slice.
function realizedVolPctMin(slice) {
  const r = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1].c > 0 && slice[i].c > 0) r.push(Math.log(slice[i].c / slice[i - 1].c));
  }
  if (r.length < 5) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1)) * 100;
}

// OI change over the window ENDING at t, i.e. the build-up BEFORE the event.
function oiBefore(oiSeries, t, minutes) {
  if (!oiSeries) return null;
  const start = t - minutes * 60000;
  let first = null, last = null;
  for (const p of oiSeries) {
    if (p.t >= start && p.t <= t) { if (first === null) first = p; last = p; }
  }
  if (!first || !last || !(first.oiUsd > 0) || first === last) return null;
  return ((last.oiUsd / first.oiUsd) - 1) * 100;
}

// Finds every flush (or up-spike, when direction is 'up') in one day of minute
// bars and describes it.
//
// Both directions are measured because the question is symmetric: an
// unsustainable spike traps shorts exactly the way an unsustainable dip traps
// longs, and a rule that only knows about dips is half a rule.
export function findFlushes(bars, oiSeries, { direction = 'down' } = {}) {
  const up = direction === 'up';
  const events = [];
  for (let i = FLUSH_WINDOW_MIN; i < bars.length - RECOVERY_WINDOW_MIN; i++) {
    const pre = bars.slice(i - FLUSH_WINDOW_MIN, i);
    const ref = up ? Math.min(...pre.map((b) => b.l)) : Math.max(...pre.map((b) => b.h));
    const window = bars.slice(i, i + FLUSH_WINDOW_MIN);
    const trough = up ? Math.max(...window.map((b) => b.h)) : Math.min(...window.map((b) => b.l));
    if (!(ref > 0) || !(trough > 0)) continue;
    const drop = ((trough / ref) - 1) * 100;
    if (up ? drop < -FLUSH_DROP_PCT : drop > FLUSH_DROP_PCT) continue;

    const after = bars.slice(i + FLUSH_WINDOW_MIN, i + FLUSH_WINDOW_MIN + RECOVERY_WINDOW_MIN);
    if (!after.length) continue;
    const peakAfter = up ? Math.min(...after.map((b) => b.l)) : Math.max(...after.map((b) => b.h));
    const endPrice = after[after.length - 1].c;
    // Fraction of the move retraced. 1.0 = fully back to the pre-event level.
    const recovered = (peakAfter - trough) / (ref - trough);
    const heldAtEnd = (endPrice - trough) / (ref - trough);

    // Did this become the new direction, or was it noise? Measured well past
    // the recovery window so a full retrace and a genuine regime change are
    // distinguishable rather than being averaged together.
    const fwdAt = (mins) => {
      const j = i + FLUSH_WINDOW_MIN + mins;
      return j < bars.length && bars[j].c > 0 && ref > 0 ? ((bars[j].c / ref) - 1) * 100 : null;
    };
    const fwd1h = fwdAt(60), fwd4h = fwdAt(240), fwd12h = fwdAt(720);

    const preSlice = bars.slice(Math.max(0, i - BASELINE_MIN), i);
    const preVol = realizedVolPctMin(preSlice);
    const preBase = preSlice.reduce((s, b) => s + b.v, 0);
    const preBuy = preSlice.reduce((s, b) => s + b.takerBuyBase, 0);
    const preTakerBuyShare = preBase > 0 ? preBuy / preBase : null;
    const preOiTrend = oiBefore(oiSeries, bars[i].t, BASELINE_MIN);
    const hourUtc = new Date(bars[i].t).getUTCHours();

    const baseSlice = bars.slice(Math.max(0, i - BASELINE_MIN), i);
    const baseVolPerMin = baseSlice.reduce((s, b) => s + b.v, 0) / Math.max(1, baseSlice.length);
    const flushVol = window.reduce((s, b) => s + b.v, 0) / FLUSH_WINDOW_MIN;
    const volSurge = baseVolPerMin > 0 ? flushVol / baseVolPerMin : null;

    const baseTrades = baseSlice.reduce((s, b) => s + b.trades, 0) / Math.max(1, baseSlice.length);
    const flushTrades = window.reduce((s, b) => s + b.trades, 0) / FLUSH_WINDOW_MIN;

    // Share of volume that was taker BUYING during the flush. Forced selling
    // hits the bid, so a cascade shows a low buy share while it runs.
    const flushBase = window.reduce((s, b) => s + b.v, 0);
    const flushBuy = window.reduce((s, b) => s + b.takerBuyBase, 0);
    const takerBuyShare = flushBase > 0 ? flushBuy / flushBase : null;

    const oi = oiAcross(oiSeries, bars[i].t, FLUSH_WINDOW_MIN + 5);

    events.push({
      t: bars[i].t, date: isoDay(bars[i].t), time: new Date(bars[i].t).toISOString().slice(11, 16),
      direction,
      dropPct: drop, refPrice: ref, troughPrice: trough,
      recovered, heldAtEnd,
      fwd1h, fwd4h, fwd12h,
      volSurge, tradeSurge: baseTrades > 0 ? flushTrades / baseTrades : null,
      takerBuyShare,
      oiChangePct: oi ? oi.pct : null,
      preVol, preTakerBuyShare, preOiTrend, hourUtc
    });
    i += RECOVERY_WINDOW_MIN;   // one event per episode
  }
  return events;
}

// Collapses overlapping detections into one episode per move.
//
// Scanning both directions double-counts by construction: the REBOUND out of a
// dip is, by the up-spike definition, a genuine up move from the trough. A
// synthetic 10% dip that recovers produced one down event AND a spurious
// +11.1% up event, and on real data DEXE reported 277 "flushes" in 60 days —
// obviously inflated. Those rebounds are not independent observations of
// "unsustainable spikes"; they are the second half of the dip already counted.
//
// Keeping the LARGER move of any overlapping pair means a real V-shape is
// recorded once, as whichever leg was more extreme.
export function dedupeEpisodes(events, windowMin = RECOVERY_WINDOW_MIN) {
  const sorted = events.slice().sort((a, b) => Math.abs(b.dropPct) - Math.abs(a.dropPct));
  const kept = [];
  for (const e of sorted) {
    const clashes = kept.some((k) => Math.abs(k.t - e.t) < windowMin * 60000);
    if (!clashes) kept.push(e);
  }
  return kept.sort((a, b) => a.t - b.t);
}

export async function scanSymbol(symbol, days, { onDay = null, directions = ['down', 'up'] } = {}) {
  const venue = venueSymbol(symbol);
  const events = [];
  let fetched = 0;
  for (let k = 1; k <= days; k++) {
    const date = isoDay(Date.now() - k * 86400000);
    let bars = null;
    try { bars = await fetchMinuteBars(venue, date); } catch { continue; }
    if (!bars || bars.length < 200) continue;
    fetched++;
    // Only pay for the OI file on days that actually contain a flush.
    const rough = directions.flatMap((d) => findFlushes(bars, null, { direction: d }));
    if (!rough.length) { if (onDay) onDay(date, 0); continue; }
    let oi = null;
    try { oi = await fetchMinuteOi(venue, date); } catch { /* OI is optional */ }
    const found = directions.flatMap((d) => findFlushes(bars, oi, { direction: d }));
    for (const e of dedupeEpisodes(found)) events.push({ symbol, ...e });
    if (onDay) onDay(date, rough.length);
  }
  return { symbol, fetched, events };
}
