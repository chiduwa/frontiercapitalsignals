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

// Finds every flush in one day of minute bars and describes it.
export function findFlushes(bars, oiSeries) {
  const events = [];
  for (let i = FLUSH_WINDOW_MIN; i < bars.length - RECOVERY_WINDOW_MIN; i++) {
    const ref = Math.max(...bars.slice(i - FLUSH_WINDOW_MIN, i).map((b) => b.h));
    const window = bars.slice(i, i + FLUSH_WINDOW_MIN);
    const trough = Math.min(...window.map((b) => b.l));
    if (!(ref > 0) || !(trough > 0)) continue;
    const drop = ((trough / ref) - 1) * 100;
    if (drop > FLUSH_DROP_PCT) continue;

    const after = bars.slice(i + FLUSH_WINDOW_MIN, i + FLUSH_WINDOW_MIN + RECOVERY_WINDOW_MIN);
    if (!after.length) continue;
    const peakAfter = Math.max(...after.map((b) => b.h));
    const endPrice = after[after.length - 1].c;
    // Fraction of the drop retraced. 1.0 = fully back to the pre-flush high.
    const recovered = (peakAfter - trough) / (ref - trough);
    const heldAtEnd = (endPrice - trough) / (ref - trough);

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
      dropPct: drop, refPrice: ref, troughPrice: trough,
      recovered, heldAtEnd,
      volSurge, tradeSurge: baseTrades > 0 ? flushTrades / baseTrades : null,
      takerBuyShare,
      oiChangePct: oi ? oi.pct : null
    });
    i += RECOVERY_WINDOW_MIN;   // one event per episode
  }
  return events;
}

export async function scanSymbol(symbol, days, { onDay = null } = {}) {
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
    const rough = findFlushes(bars, null);
    if (!rough.length) { if (onDay) onDay(date, 0); continue; }
    let oi = null;
    try { oi = await fetchMinuteOi(venue, date); } catch { /* OI is optional */ }
    for (const e of findFlushes(bars, oi)) events.push({ symbol, ...e });
    if (onDay) onDay(date, rough.length);
  }
  return { symbol, fetched, events };
}
