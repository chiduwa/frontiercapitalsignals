// Pulling away from the market: the setup that came before HBAR's run on
// 2026-09-28 (+31.2% from the UTC day's open to 17:00 UTC, while the other
// large coins fell 4.4% on average) and, over two years, before sharp moves
// away from the market in the largest coins. Evidence: docs/DECOUPLING.md.
//
// The rule, per coin, at the close of each hour:
//   volume over the last 8 hours >= 3x the coin's own hourly norm (the 30 days
//   ending a day earlier), AND that surge >= 2x the median coin's surge over
//   the same 8 hours (so it is the coin's own, not a market-wide rush), AND
//   the coin's return over those 8 hours, net of the market (beta x the
//   equal-weight return of the other coins), is at least 2 of its own 8-hour
//   standard deviations away from zero.
// Side: +1 pulling ahead of the market, -1 falling behind it.
//
// What it says, measured on Binance spot hours, 2024-09 to 2026-09, chosen on
// the first year and checked on the second: within the next 24 hours the coin
// moved at least 5% (and 2.5 of its own sds) further from the market, against
// the share of ALL the coins that did so over the same 24 hours
//   pulling ahead:  17.6% then 19.9% of setups vs 5.5% then 4.4% (t 5.6, 7.8)
//   falling behind:  7.9% then 10.2% vs 4.1% then 3.3% (t 1.6, 3.6)
// The first year alone does not carry the falling-behind side, so it is shown
// but never pushed. Without the market-wide filter the rule's setups in busy
// hours did no better than every other coin in those hours (lift 1.3).
// Which way the move goes is NOT predictable: about two in three were up on
// either side, the same as any big move, and the typical next day gave a
// little back. It is a heads-up to watch a coin, not a trade.
//
// Every timestamp here is UTC epoch milliseconds, and hours are bucketed by
// integer division, so a daylight-saving change can neither skip nor repeat an
// hour (test-decoupling-watch.mjs pins it on the 2026 clock-change dates).

export const DECOUPLING_VERSION = 'decoupling-watch-v1';
export const DECOUPLING_UNIVERSE = Object.freeze([
  'BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'TRX', 'DOGE', 'ADA', 'HYPE', 'LINK', 'XLM', 'HBAR', 'BCH', 'SUI', 'AVAX',
  'LTC', 'TON', 'SHIB', 'DOT', 'UNI', 'AAVE', 'NEAR', 'ENA', 'ONDO', 'APT', 'ICP', 'ETC', 'ARB', 'OP', 'FIL',
  'ALGO', 'TAO', 'WLD', 'PEPE', 'ATOM', 'FET', 'INJ', 'SEI', 'VET', 'XMR'
]);
export const DW = Object.freeze({
  windowHours: 720,        // 30 days: beta, the coin's excess sd, and its volume norm
  setupHours: 8,
  volumeLagHours: 24,      // the volume norm ends a day before the hour being judged
  horizonHours: 24,
  minVolumeRatio: 3,
  minRelVolume: 2,         // the coin's volume ratio over the median coin's, same hour
  minExcessZ: 2,
  eventSigmas: 2.5,        // what counts as a big move away from the market
  minEventPct: 5,
  minCoins: 5,
  cooldownHours: 24,       // at most one setup per coin per day
  chainHours: 48,          // how far back each run replays the rule to apply that cooldown
  catchUpHours: 3,         // a setup up to 2 skipped runs old is still logged and pushed
  minLiveScored: 30, minLiveDays: 10, demoteT: -2
});
// The measured rates the alert and the dashboard quote, per side, as
// [first year, second year] against the same hours' base rate
// (docs/DECOUPLING.md). `push` is whether that side may reach a phone.
export const DW_EVIDENCE = Object.freeze({
  ahead: Object.freeze({ hitRate: [0.176, 0.199], baseRate: [0.055, 0.044], t: [5.6, 7.8], upShare: 0.68, push: true }),
  behind: Object.freeze({ hitRate: [0.079, 0.102], baseRate: [0.041, 0.033], t: [1.6, 3.6], upShare: 0.69, push: false })
});

const HOUR = 3600000;
const DAY = 86400000;

// UTC epoch arithmetic only: no calendar, no local clock.
export const hourStart = (ms) => Math.floor(ms / HOUR) * HOUR;
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

// Closed hourly bars of the universe on one contiguous UTC hour grid.
export function hourlyPanel(barsBySymbol, { universe = DECOUPLING_UNIVERSE, nowMs = Date.now() } = {}) {
  const series = {};
  let first = Infinity, last = -Infinity;
  for (const s of universe) {
    const bars = barsBySymbol && barsBySymbol[s];
    if (!Array.isArray(bars) || !bars.length) continue;
    const m = new Map();
    for (const b of bars) {
      const t = hourStart(toMs(b.openTime));
      if (!Number.isFinite(t) || t + HOUR > nowMs || !(b.close > 0)) continue;   // an hour still open is not a bar yet
      m.set(t, b);
      if (t < first) first = t;
      if (t > last) last = t;
    }
    if (m.size) series[s] = m;
  }
  const syms = Object.keys(series);
  if (!syms.length) return { t0: null, n: 0, syms, close: {}, qv: {} };
  const n = (last - first) / HOUR + 1;
  const close = {}, qv = {};
  for (const s of syms) {
    const c = new Float64Array(n).fill(NaN), q = new Float64Array(n).fill(NaN);
    for (const [t, b] of series[s]) {
      const i = (t - first) / HOUR;
      c[i] = b.close;
      q[i] = Number.isFinite(b.quoteVolume) && b.quoteVolume >= 0 ? b.quoteVolume : NaN;
    }
    close[s] = c; qv[s] = q;
  }
  return { t0: first, n, syms, close, qv };
}

function logReturns(c) {
  const r = new Float64Array(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r[i] = Math.log(c[i] / c[i - 1]);
  return r;
}

// Each coin's returns and the equal-weight return of the OTHER coins.
export function withMarket(panel) {
  const r = {}, mkt = {};
  const tot = new Float64Array(panel.n), cnt = new Int32Array(panel.n);
  for (const s of panel.syms) {
    r[s] = logReturns(panel.close[s]);
    for (let i = 0; i < panel.n; i++) if (Number.isFinite(r[s][i])) { tot[i] += r[s][i]; cnt[i]++; }
  }
  for (const s of panel.syms) {
    const m = new Float64Array(panel.n).fill(NaN);
    for (let i = 0; i < panel.n; i++) {
      if (cnt[i] < DW.minCoins) continue;
      m[i] = Number.isFinite(r[s][i]) ? (tot[i] - r[s][i]) / Math.max(cnt[i] - 1, 1) : tot[i] / cnt[i];
    }
    mkt[s] = m;
  }
  return { ...panel, r, mkt };
}

// Beta for the UTC day containing index i: fitted on the 30 days before that
// day's midnight, so it is fixed for the whole day and uses nothing later.
export function dayBeta(p, s, i, cache = null) {
  const dayStartMs = Math.floor((p.t0 + i * HOUR) / DAY) * DAY;
  const d0 = (dayStartMs - p.t0) / HOUR;
  const key = `${s}|${d0}`;
  if (cache && cache.has(key)) return cache.get(key);
  let out = NaN;
  if (d0 >= DW.windowHours) {
    const x = [], y = [];
    for (let j = d0 - DW.windowHours; j < d0; j++) {
      const a = p.mkt[s][j], b = p.r[s][j];
      if (Number.isFinite(a) && Number.isFinite(b)) { x.push(a); y.push(b); }
    }
    if (x.length > DW.windowHours / 2) {
      const mx = x.reduce((u, v) => u + v, 0) / x.length, my = y.reduce((u, v) => u + v, 0) / y.length;
      let sxy = 0, sxx = 0;
      for (let k = 0; k < x.length; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; }
      if (sxx > 0) out = sxy / sxx;
    }
  }
  if (cache) cache.set(key, out);
  return out;
}

function excessAt(p, s, j, cache) {
  const b = dayBeta(p, s, j, cache);
  const r = p.r[s][j], m = p.mkt[s][j];
  return Number.isFinite(b) && Number.isFinite(r) && Number.isFinite(m) ? r - b * m : NaN;
}

// The coin's volume over the 8 hours to hour i against its own norm (the 30
// days ending a day earlier). NaN when any of those hours lacks a volume.
export function volumeRatioAt(p, s, i) {
  const W = DW.windowHours, H = DW.setupHours;
  if (!p.qv || !p.qv[s] || i < H - 1) return NaN;
  let vol = 0;
  for (let j = i - H + 1; j <= i; j++) {
    const q = p.qv[s][j];
    if (!Number.isFinite(q)) return NaN;
    vol += q;
  }
  let qn = 0, qs = 0;
  for (let j = i - DW.volumeLagHours - W + 1; j <= i - DW.volumeLagHours; j++) {
    const q = j >= 0 ? p.qv[s][j] : NaN;
    if (Number.isFinite(q)) { qn++; qs += q; }
  }
  return qn >= W / 2 && qs > 0 ? vol / (H * (qs / qn)) : NaN;
}

// The median coin's volume ratio at hour i (a geometric median: the median of
// the logs, as the study took it), over every coin with one.
export function medianVolumeRatio(p, i, cache = null) {
  const key = `vmed|${i}`;
  if (cache && cache.has(key)) return cache.get(key);
  const logs = p.syms.map((s) => Math.log(volumeRatioAt(p, s, i))).filter(Number.isFinite).sort((a, b) => a - b);
  const n = logs.length;
  const out = n < DW.minCoins ? NaN : Math.exp(n % 2 ? logs[(n - 1) / 2] : (logs[n / 2 - 1] + logs[n / 2]) / 2);
  if (cache) cache.set(key, out);
  return out;
}

// Everything the rule reads at the close of hour i, from hours <= i only.
export function coinState(p, s, i, cache = new Map()) {
  const W = DW.windowHours, H = DW.setupHours;
  if (!p.r || !p.r[s] || i < W + H) return null;
  // the coin's own excess sd over the 30 days ending the hour before
  let n = 0, s1 = 0, s2 = 0;
  for (let j = i - W; j < i; j++) {
    const e = excessAt(p, s, j, cache);
    if (Number.isFinite(e)) { n++; s1 += e; s2 += e * e; }
  }
  if (n < W / 2) return null;
  const sd = Math.sqrt(Math.max(s2 / n - (s1 / n) ** 2, 0) * n / (n - 1));
  let exc = 0, mk = 0;
  for (let j = i - H + 1; j <= i; j++) {
    const e = excessAt(p, s, j, cache), m = p.mkt[s][j];
    if (!Number.isFinite(e) || !Number.isFinite(m)) return null;
    exc += e; mk += m;
  }
  const volumeRatio = volumeRatioAt(p, s, i);
  if (!Number.isFinite(volumeRatio) || !(sd > 0)) return null;
  const excessZ = exc / (sd * Math.sqrt(H));
  const marketVolumeRatio = medianVolumeRatio(p, i, cache);
  return {
    symbol: s, at: new Date(p.t0 + i * HOUR).toISOString(), index: i,
    close: p.close[s][i], beta: dayBeta(p, s, i, cache), sdExcess: sd,
    volumeRatio, marketVolumeRatio, relVolume: volumeRatio / marketVolumeRatio,
    excessZ, excessPct: Math.expm1(exc) * 100, marketPct: Math.expm1(mk) * 100,
    threshold: Math.max(DW.eventSigmas * sd * Math.sqrt(DW.horizonHours), Math.log(1 + DW.minEventPct / 100))
  };
}

export function setupSide(state) {
  if (!state || !(state.volumeRatio >= DW.minVolumeRatio) || !(state.relVolume >= DW.minRelVolume)) return 0;
  if (state.excessZ >= DW.minExcessZ) return 1;
  if (state.excessZ <= -DW.minExcessZ) return -1;
  return 0;
}

// The setups at the latest closed hour.
export function decouplingSetups(barsBySymbol, { universe = DECOUPLING_UNIVERSE, nowMs = Date.now() } = {}) {
  const p = withMarket(hourlyPanel(barsBySymbol, { universe, nowMs }));
  if (!p.n) return { panel: p, setups: [], evaluated: 0 };
  const i = p.n - 1, cache = new Map();
  const setups = [];
  let evaluated = 0;
  for (const s of p.syms) {
    const st = coinState(p, s, i, cache);
    if (!st) continue;
    evaluated++;
    const side = setupSide(st);
    if (side) setups.push({ ...st, side });
  }
  return { panel: p, setups, evaluated };
}

// The rule replayed over the last `chainHours` closed hours with the study's
// cooldown: a setup is TAKEN at the first hour the rule holds for a coin and
// again only once 24 hours have passed since the last one taken. The chain is
// seeded with each coin's last logged setup (`lastCastMs`), so live runs take
// exactly what the study took. A coin already mid-move when the watch starts,
// or after an outage, is therefore not announced late: its first hour is
// inside the window and the current hour falls in its cooldown.
export function decouplingChain(barsBySymbol, { universe = DECOUPLING_UNIVERSE, nowMs = Date.now(), lastCastMs = {} } = {}) {
  const p = withMarket(hourlyPanel(barsBySymbol, { universe, nowMs }));
  if (!p.n) return { panel: p, taken: [], evaluated: 0 };
  const end = p.n - 1, start = Math.max(0, end - DW.chainHours + 1), cache = new Map();
  const taken = [];
  let evaluated = 0;
  for (const s of p.syms) {
    const seeded = Number.isFinite(lastCastMs[s]) ? (hourStart(lastCastMs[s]) - p.t0) / HOUR : -Infinity;
    let last = seeded;
    for (let i = start; i <= end; i++) {
      const st = coinState(p, s, i, cache);
      if (i === end && st) evaluated++;
      const side = setupSide(st);
      if (!side || i - last < DW.cooldownHours) continue;
      last = i;
      taken.push({ ...st, side });
    }
  }
  taken.sort((a, b) => a.index - b.index || a.symbol.localeCompare(b.symbol));
  return { panel: p, taken, evaluated, end };
}

// The next 24 hours' excess move after a setup at hour `castAt`, and the share
// of every coin in the universe that moved that far from the market over the
// same 24 hours (the same-window base rate). Null until those hours have closed.
export function scoreDecoupling(barsBySymbol, symbol, castAt, { universe = DECOUPLING_UNIVERSE, nowMs = Date.now() } = {}) {
  const p = withMarket(hourlyPanel(barsBySymbol, { universe, nowMs }));
  if (!p.n || !p.r[symbol]) return null;
  const i = (hourStart(toMs(castAt)) - p.t0) / HOUR;
  if (!Number.isInteger(i) || i < 0 || i + DW.horizonHours > p.n - 1) return null;
  const cache = new Map();
  const forward = (s) => {
    let x = 0;
    for (let j = i + 1; j <= i + DW.horizonHours; j++) {
      const e = excessAt(p, s, j, cache);
      if (!Number.isFinite(e)) return NaN;
      x += e;
    }
    return x;
  };
  const own = coinState(p, symbol, i, cache);
  const fwd = forward(symbol);
  if (!own || !Number.isFinite(fwd)) return null;
  let bigs = 0, n = 0;
  for (const s of p.syms) {
    const st = s === symbol ? own : coinState(p, s, i, cache);
    const f = s === symbol ? fwd : forward(s);
    if (!st || !Number.isFinite(f)) continue;
    n++;
    if (Math.abs(f) >= st.threshold) bigs++;
  }
  return {
    excessPct: Math.expm1(fwd) * 100, big: Math.abs(fwd) >= own.threshold ? 1 : 0, up: fwd > 0 ? 1 : 0,
    baseRate: n ? bigs / n : null, marketN: n
  };
}

// Notify from the start (it held in both years), until the live record trails
// the same-window base rate: day-clustered t <= -2 over >= 30 scored setups
// and >= 10 days. The caller hands it the pushed side's setups only.
export function decouplingNotifyGate(scored) {
  const rows = (scored || []).filter((r) => Number.isFinite(r.big) && Number.isFinite(r.base_rate));
  const byDay = new Map();
  for (const r of rows) {
    const d = String(r.cast_at).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r.big - r.base_rate);
  }
  const m = [...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  let t = null;
  if (m.length > 2) {
    const mu = m.reduce((a, b) => a + b, 0) / m.length;
    const sd = Math.sqrt(m.reduce((a, b) => a + (b - mu) ** 2, 0) / (m.length - 1));
    t = sd > 0 ? mu / (sd / Math.sqrt(m.length)) : null;
  }
  const hitRate = rows.length ? rows.reduce((a, r) => a + r.big, 0) / rows.length : null;
  const baseRate = rows.length ? rows.reduce((a, r) => a + r.base_rate, 0) / rows.length : null;
  const record = { scored: rows.length, days: m.length, hitRate, baseRate, t };
  if (rows.length >= DW.minLiveScored && m.length >= DW.minLiveDays && t != null && t <= DW.demoteT) {
    return { allowed: false, record, why: `live record trails the same-window base rate (t = ${t.toFixed(2)} over ${rows.length} setups)` };
  }
  return { allowed: true, record, why: rows.length
    ? `held in both years at discovery; live so far ${Math.round(hitRate * 100)}% vs ${Math.round(baseRate * 100)}% base over ${rows.length} scored`
    : 'held in both years at discovery; no live setups scored yet' };
}

const pct = (x, digits = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;

const range = (xs) => {
  const [a, b] = xs.map((x) => Math.round(x * 100)).sort((u, v) => u - v);
  return a === b ? `${a}%` : `${a}-${b}%`;
};

export function decouplingAlert(setup, { oiChangePct = null } = {}) {
  const ahead = setup.side > 0;
  const ev = ahead ? DW_EVIDENCE.ahead : DW_EVIDENCE.behind;
  const title = `${setup.symbol} ${ahead ? 'pulling away from' : 'falling away from'} the market`;
  const closeUtc = new Date(Date.parse(setup.at) + HOUR).toISOString().slice(11, 16);
  const lines = [
    `${setup.symbol} is ${pct(setup.excessPct)} against the market in the 8 hours to ${closeUtc} UTC (${Math.abs(setup.excessZ).toFixed(1)} of its usual 8-hour swings) `
      + `on ${setup.volumeRatio.toFixed(1)}x its usual volume, ${setup.relVolume.toFixed(1)}x the typical large coin's. The market itself moved ${pct(setup.marketPct)}.`
      + (Number.isFinite(oiChangePct) ? ` Open interest: ${pct(oiChangePct)} in contracts.` : ''),
    '',
    `Over the past two years, ${range(ev.hitRate)} of setups like this were followed within a day by a move of 5% or more further from the market, `
      + `against ${range(ev.baseRate)} of all the large coins over the same hours. Which way is not predictable: about ${Math.round(ev.upShare * 100)}% of those big moves were up, `
      + 'yet the typical next day gave a little back.',
    '',
    'A heads-up to watch the coin, not a buy or sell signal. Not financial advice.'
  ];
  return { title, message: lines.join('\n') };
}
