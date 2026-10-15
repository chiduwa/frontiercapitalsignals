// Market trend: moving averages for BTC and the total crypto market cap, where
// each average is heading, and the measured evidence for what they predict
// (2026-10-14, docs/MARKET_TREND.md).
//
// Asked: "can you calculate (on going) and display the moving average (and where
// its heading to) as well as other relevant predictive metrics for btc and the
// entire crypto marketcap on the page".
//
// What the evidence says (docs/research-2026-10-14-moving-averages/), BTC daily
// 2011-26 and total market cap 2013-26, forward returns 30/90/180 days, overlap-
// aware (Newey-West) t, split at 2019-01-01:
//   - Price above its 200-day average, the 50-day above the 200-day (golden
//     cross), a rising 200-day average and a full bullish stack were each
//     followed by much better 30-180 days until 2018 (t 3-4), and by nothing
//     since 2019 (|t| <= 1.5) on both series. The page shows both periods
//     beside every signal, so the trend states are context, not calls.
//   - Price far above its 200-day average (the Mayer multiple): weaker 90-180
//     days since 2019, stronger before. The halves disagree; shown, not used.
//   - What does forecast: the SIZE of the coming move. An EWMA volatility
//     range, widened by the multipliers that made it hold 68% / 95% of 2019-26
//     moves, and (total market only) the quiet-volume read from
//     docs/TOTAL_VOLUME_AND_CMC20.md: total volume in its bottom fifth of the
//     past month roughly halved the next day's big-move odds (BTC 4.4% vs 8.2%,
//     both halves).
// "Where an average is heading" needs no forecast: the closes about to leave
// its window are known, so its path is exact if price holds, and bounded if
// price stays inside its usual range. That is what the projections are.
//
// Sources, keyless, per hourly build: Binance BTCUSDT daily bars (two requests;
// the last bar is today's, so its close is the live price) and CoinMarketCap's
// global metrics (one history request, one latest). CMC stamps each daily value
// at ~02:30 UTC of the next day: it is filed under the day it covers.
import { readFileSync } from 'node:fs';
import { BINANCE_GLOBAL_BASE } from '../worker.js';

export const MARKET_TREND_VERSION = 'market-trend-v1';
export const MARKET_TREND_EVIDENCE = Object.freeze(JSON.parse(readFileSync(new URL('./market-trend-evidence.json', import.meta.url), 'utf8')));
export const MA_WINDOWS = Object.freeze([20, 50, 100, 200, 1400]);
export const MA_LABEL = Object.freeze({ 20: '20-day', 50: '50-day', 100: '100-day', 200: '200-day', 1400: '200-week' });
export const EWMA_ALPHA = 0.06;          // lambda 0.94, the research's setting
export const CHART_DAYS = 365;
export const PROJECT_DAYS = 30;
export const CROSS_HORIZON_DAYS = 120;
export const QUIET_VOLUME = Object.freeze({ rankAtMost: 0.2, windowDays: 30, bigMoveQuiet: 0.044, bigMoveOther: 0.082 });
const MAYER_BANDS = [[0, 0.8, '<0.8'], [0.8, 1.0, '0.8-1.0'], [1.0, 1.2, '1.0-1.2'], [1.2, 1.5, '1.2-1.5'], [1.5, 2.0, '1.5-2.0'], [2.0, Infinity, '>2.0']];
const DAY = 86_400_000;

const r4 = (x) => (Number.isFinite(x) ? Number(x.toPrecision(6)) : null);

function windowSum(c, end, n) {
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += c[i];
  return s;
}

export function sma(closes, n, end = closes.length - 1) {
  if (end - n + 1 < 0) return null;
  return windowSum(closes, end, n) / n;
}

/**
 * The n-day average k days ahead, for k = 1..days, if the next closes follow
 * `path(j)` (j = 1..days). The closes leaving the window are known, so this is
 * arithmetic, not a forecast.
 */
export function projectSma(closes, n, days, path) {
  const end = closes.length - 1;
  if (end - n + 1 < 0) return null;
  let s = windowSum(closes, end, n);
  const out = [];
  for (let k = 1; k <= days; k++) {
    const leaving = end - n + k;                     // index of the close dropping out
    // past day n the closes leaving are themselves projected ones
    s += path(k) - (leaving <= end ? closes[leaving] : path(leaving - end));
    out.push(s / n);
  }
  return out;
}

export function ewmaDailySd(closes, end) {
  let v = null;
  for (let i = 1; i <= end; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (!Number.isFinite(r)) continue;
    v = v == null ? r * r : (1 - EWMA_ALPHA) * v + EWMA_ALPHA * r * r;
  }
  return v == null ? null : Math.sqrt(v);
}

function realizedVol(closes, end, n) {
  if (end - n < 0) return null;
  let s = 0, s2 = 0;
  for (let i = end - n + 1; i <= end; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    s += r; s2 += r * r;
  }
  const m = s / n;
  return Math.sqrt(Math.max(s2 / n - m * m, 0) * n / (n - 1)) * Math.sqrt(365);
}

function mayerBand(x) {
  const b = MAYER_BANDS.find(([lo, hi]) => x >= lo && x < hi);
  return b ? b[2] : null;
}

/**
 * series: [{ date: 'YYYY-MM-DD', close }] ascending, one per UTC day, the last
 * one today's live value. kind: 'btc' | 'total'. volume: optional
 * [{ date, volume }] (total market only).
 */
export function trendFor(series, { kind, volume = null, live = true } = {}) {
  const ev = MARKET_TREND_EVIDENCE[kind];
  const clean = (series || []).filter((p) => p && Number.isFinite(p.close) && p.close > 0);
  if (clean.length < 260 || !ev) return { status: 'unavailable', reason: 'not enough daily history' };
  const c = clean.map((p) => p.close);
  const dates = clean.map((p) => p.date);
  const end = c.length - 1;
  const P = c[end];
  // volatility from completed days only (today's bar is still forming)
  const sd = ewmaDailySd(c, live ? end - 1 : end);
  const k68_30 = ev.range.late30.k68, k95_30 = ev.range.late30.k95;
  const k68_7 = ev.range.late7.k68, k95_7 = ev.range.late7.k95;
  const band = (k, h) => [P * Math.exp(-k * sd * Math.sqrt(h)), P * Math.exp(k * sd * Math.sqrt(h))];
  const flat = () => P;
  const up = (j) => P * Math.exp(k68_30 * sd * Math.sqrt(j));
  const down = (j) => P * Math.exp(-k68_30 * sd * Math.sqrt(j));
  const ma = [];
  for (const n of MA_WINDOWS) {
    const level = sma(c, n);
    if (level == null) continue;
    const prev20 = sma(c, n, end - 20);
    const pFlat = projectSma(c, n, PROJECT_DAYS, flat);
    const pUp = projectSma(c, n, PROJECT_DAYS, up);
    const pDown = projectSma(c, n, PROJECT_DAYS, down);
    let risingDays = 0, leaving30 = 0;
    for (let j = 1; j <= PROJECT_DAYS; j++) {
      const leaving = end - n + j <= end ? c[end - n + j] : P;
      leaving30 += leaving;
      if (P > leaving) risingDays++;
    }
    const slope20Pct = prev20 ? (level / prev20 - 1) * 100 : null;
    ma.push({
      n, label: MA_LABEL[n], level: r4(level), pricePct: r4((P / level - 1) * 100),
      slope20Pct: r4(slope20Pct),
      dir: slope20Pct == null ? null : slope20Pct > 0.25 ? 'rising' : slope20Pct < -0.25 ? 'falling' : 'flat',
      in7Flat: r4(pFlat[6]), in30Flat: r4(pFlat[PROJECT_DAYS - 1]),
      in30Low: r4(pDown[PROJECT_DAYS - 1]), in30High: r4(pUp[PROJECT_DAYS - 1]),
      // tomorrow the average rises only if tomorrow's close beats the one leaving
      keepRisingAbove: r4(c[end - n + 1]),
      risingDaysIfFlat: risingDays, leavingAvg30: r4(leaving30 / PROJECT_DAYS)
    });
  }
  // 50 / 200 cross: current state, since when, and when they meet if price holds
  let cross = null;
  const s50 = sma(c, 50), s200 = sma(c, 200);
  if (s50 != null && s200 != null) {
    const golden = s50 > s200;
    let since = null;
    for (let i = end - 1; i >= 249; i--) {
      if ((sma(c, 50, i) > sma(c, 200, i)) !== golden) { since = i + 1; break; }
    }
    const f50 = projectSma(c, 50, CROSS_HORIZON_DAYS, flat), f200 = projectSma(c, 200, CROSS_HORIZON_DAYS, flat);
    let meet = null;
    for (let k = 0; k < CROSS_HORIZON_DAYS; k++) if ((f50[k] > f200[k]) !== golden) { meet = k + 1; break; }
    cross = { state: golden ? 'golden' : 'death', sinceDate: since != null ? dates[since] : null,
      sinceDays: since != null ? end - since : null, gapPct: r4((s50 / s200 - 1) * 100), meetInDaysIfFlat: meet };
  }
  // all-time high within the history we hold, and the drawdown from it
  let ath = -Infinity, athI = 0;
  for (let i = 0; i <= end; i++) if (c[i] > ath) { ath = c[i]; athI = i; }
  const mayer = s200 ? P / s200 : null;
  const mBand = mayer != null ? mayerBand(mayer) : null;
  // realized-vol percentile: today's 30-day vol against the last year of it
  const vol30 = realizedVol(c, live ? end - 1 : end, 30);
  let volPct = null;
  if (vol30 != null && end > 400) {
    const hist = [];
    for (let i = end - 365; i < end; i++) hist.push(realizedVol(c, i, 30));
    volPct = hist.filter((x) => x <= vol30).length / hist.length;
  }
  const state = {
    above200: s200 != null ? P > s200 : null,
    golden: cross ? cross.state === 'golden' : null,
    rising200: s200 != null && sma(c, 200, end - 20) != null ? s200 > sma(c, 200, end - 20) : null,
    stack: null
  };
  const s20 = sma(c, 20);
  if (s20 != null && s50 != null && s200 != null) {
    state.stack = P > s20 && s20 > s50 && s50 > s200 ? 'bull' : P < s20 && s20 < s50 && s50 < s200 ? 'bear' : 'mixed';
  }
  const signals = [];
  const pick = (key, label, now, evKey) => {
    const e = ev.states[evKey];
    if (now == null || !e) return;
    const side = (x) => (now ? { median: x.trueMedian, up: x.trueUp, otherMedian: x.falseMedian, otherUp: x.falseUp }
      : { median: x.falseMedian, up: x.falseUp, otherMedian: x.trueMedian, otherUp: x.trueUp });
    signals.push({ key, label, now, early: { ...side(e.early90), t: e.early90.t }, late: { ...side(e.late90), t: e.late90.t } });
  };
  pick('above200', 'Price above the 200-day average', state.above200, 'above200');
  pick('golden', '50-day above the 200-day (golden cross)', state.golden, 'golden');
  pick('rising200', '200-day average rising (vs 20 days ago)', state.rising200, 'rising200');
  if (state.stack === 'bull') pick('stack', 'Full bullish stack (price > 20 > 50 > 200)', true, 'stack_bull');
  else if (state.stack === 'bear') pick('stack', 'Full bearish stack (price < 20 < 50 < 200)', true, 'stack_bear');
  // chart: the last year, and the next 30 days of the 50- and 200-day if price holds / stays in range
  const from = Math.max(0, end - CHART_DAYS + 1);
  const chart = { dates: dates.slice(from), close: c.slice(from).map(r4), sma50: [], sma200: [], sma1400: [] };
  for (let i = from; i <= end; i++) {
    chart.sma50.push(r4(sma(c, 50, i))); chart.sma200.push(r4(sma(c, 200, i))); chart.sma1400.push(r4(sma(c, 1400, i)));
  }
  chart.projection = {
    days: PROJECT_DAYS,
    sma50: (projectSma(c, 50, PROJECT_DAYS, flat) || []).map(r4),
    sma200: (projectSma(c, 200, PROJECT_DAYS, flat) || []).map(r4),
    sma200Low: (projectSma(c, 200, PROJECT_DAYS, down) || []).map(r4),
    sma200High: (projectSma(c, 200, PROJECT_DAYS, up) || []).map(r4)
  };
  const out = {
    status: 'ok', kind, asOf: dates[end], live, value: r4(P),
    change30Pct: r4((P / c[end - 30] - 1) * 100), change90Pct: r4((P / c[end - 90] - 1) * 100),
    ath: r4(ath), athDate: dates[athI], drawdownPct: r4((P / ath - 1) * 100), daysSinceAth: end - athI,
    ma, cross, state,
    mayer: mayer != null ? { value: r4(mayer), band: mBand, early: ev.mayerBands[mBand]?.early || null, late: ev.mayerBands[mBand]?.late || null } : null,
    range: {
      dailySdPct: r4(sd * 100),
      d7: (([lo68, hi68], [lo95, hi95]) => ({ lo68: r4(lo68), hi68: r4(hi68), lo95: r4(lo95), hi95: r4(hi95) }))(band(k68_7, 7), band(k95_7, 7)),
      d30: (([lo68, hi68], [lo95, hi95]) => ({ lo68: r4(lo68), hi68: r4(hi68), lo95: r4(lo95), hi95: r4(hi95) }))(band(k68_30, 30), band(k95_30, 30)),
      calibration: { in68: [ev.range.late7.in1sd, ev.range.late30.in1sd], k68: [k68_7, k68_30], k95: [k95_7, k95_30] },
      vol30Annual: r4(vol30), vol30Percentile1y: r4(volPct)
    },
    signals, chart
  };
  if (volume && volume.length > QUIET_VOLUME.windowDays) {
    const v = volume.filter((x) => x && Number.isFinite(x.volume) && x.volume > 0);
    const now = v[v.length - 1];
    const win = v.slice(-QUIET_VOLUME.windowDays - 1, -1).map((x) => x.volume);
    const rank = win.filter((x) => x <= now.volume).length / win.length;
    out.volume = { date: now.date, volume24h: r4(now.volume), median30: r4([...win].sort((a, b) => a - b)[Math.floor(win.length / 2)]),
      rank30: r4(rank), quiet: rank <= QUIET_VOLUME.rankAtMost, bigMoveQuiet: QUIET_VOLUME.bigMoveQuiet, bigMoveOther: QUIET_VOLUME.bigMoveOther };
  }
  return out;
}

// ---- sources -------------------------------------------------------------

async function defaultFetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (FCS market trend)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** BTCUSDT daily closes, ~2,000 days, the last one today's (live). */
export async function fetchBtcDaily({ fetchJson = defaultFetchJson, days = 2000 } = {}) {
  const rows = [];
  let endTime = null;
  while (rows.length < days) {
    const page = await fetchJson(`${BINANCE_GLOBAL_BASE}/klines?symbol=BTCUSDT&interval=1d&limit=1000${endTime != null ? `&endTime=${endTime}` : ''}`);
    if (!Array.isArray(page) || !page.length) break;
    rows.unshift(...page);
    if (page.length < 1000) break;
    endTime = Number(page[0][0]) - 1;
  }
  const byDay = new Map();
  for (const r of rows) byDay.set(isoDay(Number(r[0])), Number(r[4]));
  return [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

/**
 * Total crypto market cap, BTC dominance and total 24h volume, daily, plus the
 * live reading as today's point. CMC's value stamped ~02:30 UTC on day D covers
 * day D-1, so it is filed under D-1.
 */
export async function fetchTotalMarket({ fetchJson = defaultFetchJson, nowMs = Date.now(), days = 1500 } = {}) {
  const end = Math.floor(nowMs / 1000), start = end - days * 86400;
  const base = 'https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes';
  const hist = await fetchJson(`${base}/historical?format=chart_crypto_details&interval=1d&timeStart=${start}&timeEnd=${end}`);
  const quotes = hist?.data?.quotes;
  if (!Array.isArray(quotes) || quotes.length < 260) throw new Error('CMC history unavailable');
  const byDay = new Map();
  for (const q of quotes) {
    const u = q?.quote?.[0];
    const t = Date.parse(q.timestamp);
    if (!u || !Number.isFinite(t) || !(u.totalMarketCap > 0)) continue;
    byDay.set(isoDay(t - DAY), { close: u.totalMarketCap, volume: u.totalVolume24H, btcDominance: q.btcDominance });
  }
  let live = false;
  try {
    const latest = await fetchJson(`${base}/latest`);
    const u = latest?.data?.quotes?.[0];
    if (u && u.totalMarketCap > 0) {
      byDay.set(isoDay(nowMs), { close: u.totalMarketCap, volume: u.totalVolume24H, btcDominance: latest.data.btcDominance });
      live = true;
    }
  } catch { /* the history alone still gives every average, one day older */ }
  const rows = [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, x]) => ({ date, ...x }));
  return { rows, live };
}

/**
 * The payload block. A source that fails this hour keeps the previous hour's
 * block for that series, marked stale, rather than dropping the panel.
 */
export async function buildMarketTrend({ fetchJson = defaultFetchJson, nowMs = Date.now(), previous = null } = {}) {
  const out = { version: MARKET_TREND_VERSION, generatedAt: new Date(nowMs).toISOString() };
  try {
    const btc = await fetchBtcDaily({ fetchJson });
    out.btc = trendFor(btc, { kind: 'btc', live: btc.length > 0 && btc[btc.length - 1].date === isoDay(nowMs) });
  } catch (e) {
    out.btc = previous?.btc?.status === 'ok' ? { ...previous.btc, stale: true } : { status: 'unavailable', reason: String(e.message || e) };
  }
  try {
    const { rows, live } = await fetchTotalMarket({ fetchJson, nowMs });
    out.total = trendFor(rows.map((r) => ({ date: r.date, close: r.close })), {
      kind: 'total', live, volume: rows.filter((r) => r.date >= '2022-01-10').map((r) => ({ date: r.date, volume: r.volume }))
    });
    const last = rows[rows.length - 1], back30 = rows[rows.length - 31];
    if (out.total.status === 'ok' && last && back30) {
      out.total.btcDominance = r4(last.btcDominance);
      out.total.btcDominanceChange30 = r4(last.btcDominance - back30.btcDominance);
    }
  } catch (e) {
    out.total = previous?.total?.status === 'ok' ? { ...previous.total, stale: true } : { status: 'unavailable', reason: String(e.message || e) };
  }
  return out;
}
