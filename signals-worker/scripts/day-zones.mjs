// Day zones: today's forecast top and bottom for each always-tracked coin
// (docs/DAY_ZONES_AND_BOXES.md, 2026-10-02).
//
// Asked: "for my always tracked assets, based on the historical median and
// forecasted move for the day, can you send me notifications if a forecasted
// top/near top or bottom/near bottom for the asset has been detected. figure
// out the best time to use as a reference".
//
// The forecast (day-zones-v3, 2026-10-06, docs/DAY_ZONE_METHODS_AND_CONFUSION.md):
//   top    = today's 00:00 UTC open x exp(U^),  bottom = open x exp(-D^)
//   U^ = (median up-move from the open over the last 60 UTC days)
//        x exp(a + b . x),  D^ likewise with its own coefficients,
// a median (quantile) regression pooled over the eight coins, fitted on every
// coin-day 2018-26, of log(the day's move / its 60-day median) on: the last
// 24 hours' volatility vs usual, 24h volume vs its 30-day median, yesterday's
// move in typical moves, the last 7 days' moves vs the median, how far the
// 60-day MEAN sits above the median (a fat recent tail), and the weekday.
// Asked 2026-10-06 to try the mean, the "flaw of averages" and simulation
// instead of the median. Judged on 2019-26, every model fitted only on days
// before the ones it forecast:
//   - the plain mean: 9-10% WORSE (t +14/+15). It sits above the median, so
//     65% of days stay inside it: a different level, not a better one;
//   - Monte Carlo days stitched from past hours or 6-hour blocks: 1.5-5% worse
//     (stitching breaks up trend days); a Brownian-motion (reflection
//     principle) level from EWMA or GARCH volatility: -1.5% to +0.2%, mixed;
//   - this regression: 1.7% better in 2019-22 (t -3.7) and 2.4% in 2023-26
//     (t -5.2), better on every coin; fitted on 2019-22 alone and frozen, still
//     2.4% better on 2023-26 (t -5.2), HYPE included. The mean helps as an
//     INPUT (the mean/median gap), not as a replacement for the median.
//   - one model per coin was worse than this pooled one (picking each coin's
//     best method on 2019-22 scored 0.971 on 2025-26 vs 0.965 for this);
//   - neural networks (2026-10-07: an MLP, an LSTM on 14 days of 4-hour bars)
//     tied it and boosted trees did worse, refit on the same schedule; a
//     50/50 blend gained 0.2-0.5% but not on BTC/ETH/SOL in 2025-26, so the
//     model stays linear.
// Calibrated: 49-50% of days stay inside each side. It replaces v2 (60-day
// median x (24h vol / usual)^0.5 x the 2026-10-02 activity multiplier), whose
// volume and yesterday's-move inputs it keeps, refitted.
//
// The reference hour: midnight UTC. No hour beat it significantly (16-20 UTC
// were 1.5-3% better, t -0.1 to -0.7); 08 and 14 UTC were measurably worse.
//
// What it is NOT: a top or bottom detector. Reaching the forecast top late in
// the UTC day, the day's high still ended more than a quarter of a typical
// move higher about 7 times in 10, and price on average kept rising into the
// close: more continuation than a random walk of the same size gives. The
// Worker's alert (worker.js dueDayZoneAlerts) says so in every push.
//
// Pure functions first; the fetchers and the payload builder after. Cost: two
// Binance requests per coin per build (one Hyperliquid request for a coin
// Binance spot lists too recently, HYPE for now), all public and keyless.
import { BINANCE_GLOBAL_BASE, FAVORITE_SYMBOLS } from '../worker.js';

export const DAY_ZONE_VERSION = 'day-zones-v3';
export const DAY_ZONE = Object.freeze({
  windows: 60,           // past UTC days in the median
  refHourUtc: 0,
  historyDays: 62,       // 60 windows, the 24 hours before the oldest, and today
  volumeDays: 30,
  typicalDays: 60,
  lastWeekDays: 7,
  // Extrapolation guard: no level beyond 4x its 60-day median move (0.6% of
  // coin-days). Uncapped, the top 1% of adjustments (median 3.6x) left 55% of
  // those days inside instead of 50% and erred 14% more than v2 there. On
  // 2019-22 the cap ties (0.9782 vs 0.9779 of v2's error) with a steadier gain
  // (t -8.4 vs -7.5); on 2023-26 0.973 vs 0.977. A guard, not a fitted value.
  maxVsMedian: 4,
  // log(move / 60-day median) = const + vol x log(last 24h hourly vol / its
  // 60-day median) + volume x log(24h volume / its 30-day median) + move x
  // |yesterday's move| in typical moves + lastWeek x log(mean of the last 7
  // days' moves / median) + tailGap x log(60-day mean / median) + the weekday
  // (Monday..Saturday against Sunday). Exact median regression (HiGHS) on
  // 18,496 coin-days through 2026-10-05; research-2026-10-06-mean-median-sim/
  // scripts/ablate.py prints these. Activity (2026-10-02) is still in it: heavy
  // volume widens the DOWNSIDE most (0.27 vs -0.04 up), recent volatility the
  // upside (0.40 vs 0.05). Open interest and taker flow stay out (no reliable
  // effect, docs/DAY_ZONES_AND_BOXES.md 2b).
  model: Object.freeze({
    up: Object.freeze({ const: -0.3057899399322884, vol: 0.40248427693923927, volume: -0.03532565679523615, move: 0.07292214532219643,
      lastWeek: 0.22890500618962445, tailGap: 0.4147058930392093,
      weekday: Object.freeze([0.24836784234710008, -0.0571291043738949, 0.13782809159545165, -0.05462736140513508, 0.06838191381926845, -0.1722126646214736, 0]) }),
    down: Object.freeze({ const: -0.37723122664871384, vol: 0.047470318693529696, volume: 0.26516647457934894, move: 0.05795785859689604,
      lastWeek: 0.32347251683324874, tailGap: 0.6779763611663253,
      weekday: Object.freeze([0.1838254199799428, 0.08982304041147476, 0.06884106705971033, 0.1069795808852183, -0.01957961101028538, -0.44618034319605865, 0]) })
  })
});
// weekday[] is indexed Monday = 0 .. Sunday = 6 (the study's pandas dayofweek).

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Population standard deviation (numpy's default), as the study computed it.
function std(xs) {
  const v = xs.filter(Number.isFinite);
  if (v.length < 12) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}

// Quote volume over the 24 hours that end at `startMs` (at least 20 bars).
function preWindowVolume(byTime, startMs) {
  let sum = 0, n = 0;
  for (let k = 1; k <= 24; k++) {
    const b = byTime.get(startMs - k * HOUR);
    if (b && Number.isFinite(b.qv)) { sum += b.qv; n++; }
  }
  return n >= 20 ? sum : NaN;
}

// Hourly volatility over the 24 hours that END at `startMs`: the 24 log
// returns between the closes of the 25 bars ending there. Nothing after the
// open is used.
function preWindowVol(byTime, startMs) {
  const r = [];
  for (let k = 24; k >= 1; k--) {
    const a = byTime.get(startMs - (k + 1) * HOUR), b = byTime.get(startMs - k * HOUR);
    if (a && b && a.c > 0 && b.c > 0) r.push(Math.log(b.c / a.c));
  }
  return std(r);
}

/**
 * bars: hourly bars { t (open ms), o, h, l, c }, any order. Returns the zone
 * for the UTC day containing nowMs, or null when today's 00:00 bar or the
 * history is missing. Every input is from before today's open except the
 * open itself.
 */
export function dayZoneForecast(bars, nowMs, { windows = DAY_ZONE.windows, model = DAY_ZONE.model } = {}) {
  const byTime = new Map();
  for (const b of bars || []) {
    if ([b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.o > 0 && b.l > 0) byTime.set(b.t, b);
  }
  const today = Math.floor(nowMs / DAY) * DAY + DAY_ZONE.refHourUtc * HOUR;
  const first = byTime.get(today);
  if (!first) return null;
  let oldest = Infinity;
  for (const t of byTime.keys()) if (t < oldest) oldest = t;
  const past = [];                                       // complete UTC days before today, newest first
  for (let d = today - DAY; past.length < windows && d >= oldest; d -= DAY) {
    let ok = true, hi = -Infinity, lo = Infinity;
    for (let k = 0; k < 24; k++) {
      const b = byTime.get(d + k * HOUR);
      if (!b) { ok = false; break; }
      hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    }
    if (!ok) continue;
    const o = byTime.get(d).o;
    const cum = [];                                       // quote volume from the day's open through each hour
    for (let k = 0, acc = 0; k < 24; k++) { acc += Number(byTime.get(d + k * HOUR).qv); cum.push(acc); }
    past.push({ up: Math.log(hi / o), down: Math.log(o / lo), vol: preWindowVol(byTime, d), qPrev: preWindowVolume(byTime, d), cum });
  }
  if (past.length < windows) return null;
  const ups = past.map(p => p.up), downs = past.map(p => p.down);
  const medUp = median(ups), medDown = median(downs);
  if (!(medUp > 0) || !(medDown > 0)) return null;
  const typical = median(past.map(p => p.vol));
  const now = preWindowVol(byTime, today);
  // The regression's inputs, every one known at today's open. A missing input
  // counts as ordinary (0), as it did in the study.
  const volLog = Number.isFinite(now) && now > 0 && typical > 0 ? Math.log(now / typical) : 0;
  const recentQ = past.slice(0, DAY_ZONE.volumeDays).map(p => p.qPrev).filter(Number.isFinite);
  const qNorm = recentQ.length >= 20 ? median(recentQ) : NaN;
  const qNow = preWindowVolume(byTime, today);
  const volume24Log = Number.isFinite(qNow) && qNorm > 0 ? Math.log(qNow / qNorm) : 0;
  const typicalMove = median(past.slice(0, DAY_ZONE.typicalDays).map(p => (p.up + p.down) / 2));
  const ago = byTime.get(today - 25 * HOUR);
  const yesterdayMove = ago && ago.c > 0 && typicalMove > 0 ? Math.abs(Math.log(first.o / ago.c)) / typicalMove : 0;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const weekday = (new Date(today).getUTCDay() + 6) % 7;       // Monday = 0
  const side = (m, med, xs) => {
    const lastWeek = Math.log(mean(xs.slice(0, DAY_ZONE.lastWeekDays)) / med);
    const tailGap = Math.log(mean(xs) / med);
    const lin = m.const + m.vol * volLog + m.volume * volume24Log + m.move * yesterdayMove
      + m.lastWeek * lastWeek + m.tailGap * tailGap + m.weekday[weekday];
    return { move: med * Math.min(Math.exp(lin), DAY_ZONE.maxVsMedian), lastWeek, tailGap };
  };
  const U = side(model.up, medUp, ups), D = side(model.down, medDown, downs);
  const up = U.move, down = D.move;
  if (!(up > 0) || !(down > 0)) return null;
  const open = first.o;
  // Volume so far today against the same hours' median over the 30 days before:
  // the alert quotes different odds on light, normal and heavy days.
  let volumeSoFar = null;
  let k = -1, acc = 0;
  for (let j = 0; j < 24; j++) {
    const b = byTime.get(today + j * HOUR);
    if (!b || today + (j + 1) * HOUR > nowMs || !Number.isFinite(b.qv)) break;
    acc += b.qv; k = j;
  }
  if (k >= 0) {
    const norm = median(past.slice(0, DAY_ZONE.volumeDays).map(p => p.cum[k]).filter(Number.isFinite));
    if (norm > 0) volumeSoFar = { ratio: acc / norm, throughHourUtc: k };
  }
  return {
    date: new Date(today).toISOString().slice(0, 10),
    open,
    top: open * Math.exp(up), bottom: open * Math.exp(-down),
    upLog: up, downLog: down,
    upPct: Math.expm1(up) * 100, downPct: (1 - Math.exp(-down)) * 100,
    medianUpPct: Math.expm1(medUp) * 100, medianDownPct: (1 - Math.exp(-medDown)) * 100,
    windows: past.length,
    // Each level against the plain 60-day median move (1 = no adjustment).
    vsMedian: { up: up / medUp, down: down / medDown },
    inputs: { volRatio: Math.exp(volLog), lastWeekUp: Math.exp(U.lastWeek), lastWeekDown: Math.exp(D.lastWeek),
      tailGapUp: Math.exp(U.tailGap), tailGapDown: Math.exp(D.tailGap), weekday },
    activity: { volume24Ratio: Math.exp(volume24Log), yesterdayMoveTypical: yesterdayMove },
    volumeSoFar
  };
}

// ------------------------------- fetchers -----------------------------------

async function getJson(url, init = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': 'frontier-capital-signals', ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function binanceHourly(symbol, startMs, { fetcher = getJson } = {}) {
  const out = [];
  let from = startMs;
  for (let page = 0; page < 3; page++) {
    const j = await fetcher(`${BINANCE_GLOBAL_BASE}/klines?symbol=${encodeURIComponent(symbol)}USDT&interval=1h&startTime=${from}&limit=1000`);
    if (!Array.isArray(j) || !j.length) break;
    for (const k of j) out.push({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), qv: Number(k[7]) });
    if (j.length < 1000) break;
    from = Number(j[j.length - 1][0]) + HOUR;
  }
  return out;
}

// Hyperliquid's public candles, for a coin Binance spot has listed too
// recently to give 60 days (HYPE: Binance spot from 2026-09-24). Its
// perpetual's price, which the study used for HYPE's history too.
export async function hyperliquidHourly(coin, startMs, endMs, { fetcher = getJson } = {}) {
  const j = await fetcher('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: startMs, endTime: endMs } })
  });
  // Volume in coins; times the close it is the quote volume the ratios need.
  return (Array.isArray(j) ? j : []).map(k => ({ t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), qv: Number(k.v) * Number(k.c) }));
}

/** The payload block: one zone per always-tracked coin for today. Never throws. */
export async function buildDayZones(nowMs = Date.now(), { binance = binanceHourly, hyperliquid = hyperliquidHourly, symbols = [...FAVORITE_SYMBOLS] } = {}) {
  const start = Math.floor(nowMs / DAY) * DAY - DAY_ZONE.historyDays * DAY;
  const bySymbol = {};
  const missing = [];
  await Promise.all(symbols.map(async (symbol) => {
    let zone = null, source = null;
    try {
      zone = dayZoneForecast(await binance(symbol, start), nowMs);
      source = 'binance-spot';
    } catch (e) { /* the fallback below */ }
    if (!zone) {
      try {
        zone = dayZoneForecast(await hyperliquid(symbol, start, nowMs), nowMs);
        source = 'hyperliquid-perp';
      } catch (e) { /* recorded as missing */ }
    }
    if (zone) bySymbol[symbol] = { ...zone, source };
    else missing.push(symbol);
  }));
  return {
    version: DAY_ZONE_VERSION,
    refHourUtc: DAY_ZONE.refHourUtc,
    date: new Date(Math.floor(nowMs / DAY) * DAY).toISOString().slice(0, 10),
    computedAt: new Date(nowMs).toISOString(),
    bySymbol, missing
  };
}
