// Day zones: today's forecast top and bottom for each always-tracked coin
// (docs/DAY_ZONES_AND_BOXES.md, 2026-10-02).
//
// Asked: "for my always tracked assets, based on the historical median and
// forecasted move for the day, can you send me notifications if a forecasted
// top/near top or bottom/near bottom for the asset has been detected. figure
// out the best time to use as a reference".
//
// The forecast, chosen on 2018-26 hourly bars of the eight coins:
//   top    = today's 00:00 UTC open x exp(U^),  U^ = median up-move from the open
//   bottom = today's 00:00 UTC open x exp(-D^), D^ = median down-move
// over the last 60 UTC days, each scaled by (the last 24 hours' hourly
// volatility / its median before those 60 days) ^ 0.5. The scaling cut the
// error by about 3% in both periods; window length (30/60/90) and a weekday
// factor changed little. Calibrated: about half of days stay inside each side.
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

export const DAY_ZONE_VERSION = 'day-zones-v2';
export const DAY_ZONE = Object.freeze({
  windows: 60,           // past UTC days in the median
  volPower: 0.5,         // partial adjustment toward the last 24 hours' volatility
  refHourUtc: 0,
  historyDays: 62,       // 60 windows, the 24 hours before the oldest, and today
  // Activity (asked 2026-10-02: "look out for unusual activity ... bake that
  // into the forecast or the notification"). Measured on the 8 coins: the day's
  // range ran larger than the forecast after heavy volume (t 4.8 / 3.1 in
  // 2018-22 / 2023-26) and after a big move (t 9.1 / 7.0); on the busiest tenth
  // of days the plain levels were broken 56-57% of the time instead of 50%.
  // band x exp(volumeWeight x log(24h volume / its 30-day median)
  //            + moveWeight x |yesterday's move| in typical moves),
  // fitted on 2018-22: the busiest tenth back to 52%. Open interest and taker
  // flow did not move the range or tilt it up or down reliably (t 1.1-1.8 at
  // best, signs that change between halves), so they are not in it.
  volumeWeight: 0.04,
  moveWeight: 0.025,
  volumeDays: 30,
  typicalDays: 60
});

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
export function dayZoneForecast(bars, nowMs, { windows = DAY_ZONE.windows, volPower = DAY_ZONE.volPower } = {}) {
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
  const medUp = median(past.map(p => p.up)), medDown = median(past.map(p => p.down));
  const typical = median(past.map(p => p.vol));
  const now = preWindowVol(byTime, today);
  const scale = Number.isFinite(now) && typical > 0 ? Math.pow(now / typical, volPower) : 1;
  // Activity at the open: yesterday's volume against its norm, yesterday's move
  // against a typical day. A missing input counts as ordinary (no widening).
  const recentQ = past.slice(0, DAY_ZONE.volumeDays).map(p => p.qPrev).filter(Number.isFinite);
  const qNorm = recentQ.length >= 20 ? median(recentQ) : NaN;
  const qNow = preWindowVolume(byTime, today);
  const volume24Log = Number.isFinite(qNow) && qNorm > 0 ? Math.log(qNow / qNorm) : 0;
  const typicalMove = median(past.slice(0, DAY_ZONE.typicalDays).map(p => (p.up + p.down) / 2));
  const ago = byTime.get(today - 25 * HOUR);
  const yesterdayMove = ago && ago.c > 0 && typicalMove > 0 ? Math.abs(Math.log(first.o / ago.c)) / typicalMove : 0;
  const multiplier = Math.exp(DAY_ZONE.volumeWeight * volume24Log + DAY_ZONE.moveWeight * yesterdayMove);
  const up = medUp * scale * multiplier, down = medDown * scale * multiplier;
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
    volScale: scale, windows: past.length,
    activity: { volume24Ratio: Math.exp(volume24Log), yesterdayMoveTypical: yesterdayMove, multiplier },
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
