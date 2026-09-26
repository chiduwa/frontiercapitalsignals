// Volume exhaustion across the whole market, plus the recent prints behind it.
// User-requested 2026-09-26: "volume exhaustion seems to be a good metric to
// let me know when to sell. lets try tracking that more accurately for all the
// assets and market in general if possible."
//
// Pure. The live scanner hands this every coin's hourly bars and gets numbers
// back; nothing here fetches or writes. What the numbers MEAN was measured
// before any of it was built (docs/research-2026-09-26/EXHAUSTION.md, 478
// Binance pairs, Jan 2024 - Sep 2026), and the answer is different at the two
// scales, which is the most useful thing this module can say:
//
//   ONE SMALLER COIN printing exhaustion has been followed by underperformance:
//   about -3% against the market over 24h, holding in both halves of the
//   history. That is a sell signal, and SURGE_CONFIGS carries it.
//
//   THE MARKET AS A WHOLE surging on volume in a rally has been followed by
//   MORE upside, not less: +2.7% over 3 days and +4.8% over a week for the
//   equal-weight market (both halves positive, 30 days in the sample). And a
//   crowd of coins printing exhaustion at the same time has not marked market
//   tops either way. So the market gauge is context, never a sell alert.
//
// The same split shows up by coin size: in the deepest books (BTC, ETH, SOL,
// XRP, HBAR, ARB and ~40 more) a volume surge has been continuation, not a top.
import { surgeFeatures, surgeConfigMatches, SURGE_CONFIGS } from '../worker.js';
import { changeLadder, formatLadder, formatPct, formatPrice } from './price-change.mjs';

export const GAUGE_LOOKBACK_HOURS = 24;
export const MAJOR_LIQUIDITY_30D = 400_000;   // median hourly quote volume, USD

// Measured reference levels for the breadth reading (share of scanned coins
// with a print in the trailing 24h), so a reader can tell a busy day from an
// ordinary one.
export const BREADTH_REFERENCE = Object.freeze({ median: 0.031, p90: 0.089, p97: 0.157 });
export const MARKET_SURGE = Object.freeze({ minVolumeZ: 1.5, minRun72Z: 1.5 });

// The headline numbers the dashboard and alerts quote. Every one is an
// out-of-sample-checked measurement from the research above, not a target.
export const EXHAUSTION_EVIDENCE = Object.freeze({
  period: 'Jan 2024 to Sep 2026, 478 Binance pairs, hourly',
  byTier: {
    thin: { excess24: -5.32, excess72: -6.54, fellShare24: 0.78, note: 'hourly volume under about $33K' },
    mid: { excess24: -2.82, excess72: -3.02, fellShare24: 0.70, note: 'the middle of the market' },
    major: { excess24: -0.27, excess72: 0.59, fellShare24: 0.55, note: 'no reliable effect; surges here have tended to continue' }
  },
  bothRules: { excess24: -4.62, excess72: -5.42, fellShare24: 0.76, medianMove24: -7.35, pokedHigherShare24: 0.66, medianPokeHigher24: 7.9 },
  // What an alert quotes: the record for exactly its case, which rules fired
  // and the coin's size. Every cell held in both halves of the history.
  byCase: {
    'both|thin': { n: 2288, excess24: -6.65, fellShare24: 0.80, pokedHigherShare24: 0.63, medianPokeHigher24: 7.6 },
    'both|mid': { n: 2857, excess24: -3.91, fellShare24: 0.73, pokedHigherShare24: 0.67, medianPokeHigher24: 8.3 },
    'perCoinOnly|thin': { n: 2052, excess24: -3.50, fellShare24: 0.75, pokedHigherShare24: 0.72, medianPokeHigher24: 5.8 },
    'perCoinOnly|mid': { n: 4415, excess24: -1.95, fellShare24: 0.65, pokedHigherShare24: 0.80, medianPokeHigher24: 6.8 },
    'rule20Only|thin': { n: 938, excess24: -2.86, fellShare24: 0.74, pokedHigherShare24: 0.63, medianPokeHigher24: 5.4 },
    'rule20Only|mid': { n: 1208, excess24: -2.71, fellShare24: 0.70, pokedHigherShare24: 0.70, medianPokeHigher24: 6.3 }
  },
  market: { surgeInRally72: 2.74, surgeInRally168: 4.83, days: 30 }
});

// What breadth counts: the per-coin rule's feature test on EVERY tier, exactly
// as the research defined it. The liquidity cut is a decision about alerting,
// not about what counts as a print.
const BREADTH_TEST = Object.freeze({ minRatio: 0, minVolZ: 3, minBarZ: 3, minRun24Z: 1.5, requireRising: true });

const EXHAUSTION_CONFIGS = SURGE_CONFIGS.filter((c) => c.dir === -1 && c.proven);

export function tierOf(liquidity30d) {
  if (!Number.isFinite(liquidity30d)) return null;
  return liquidity30d >= MAJOR_LIQUIDITY_30D ? 'major' : liquidity30d < 33_000 ? 'thin' : 'mid';
}

// Every print in the last `lookback` CLOSED bars of one coin. The final bar is
// still forming and is never read, the same rule scanSurgeConfigs follows.
export function recentPrints(symbol, bars, { lookback = GAUGE_LOOKBACK_HOURS } = {}) {
  const out = [];
  if (!Array.isArray(bars) || bars.length < 3) return out;
  const last = bars.length - 2;
  for (let i = last; i > last - lookback && i >= 0; i--) {
    const f = surgeFeatures(bars, i);
    if (!f) continue;
    const configs = EXHAUSTION_CONFIGS.filter((c) => surgeConfigMatches(c, f)).map((c) => c.id);
    const breadthHit = surgeConfigMatches(BREADTH_TEST, f);
    if (!configs.length && !breadthHit) continue;
    out.push({
      symbol, at: f.at, close: f.close, ratio: f.ratio, tradeRatio: f.tradeRatio, barPct: f.barPct,
      volZ: f.volZ, barZ: f.barZ, run24Z: f.run24Z, liquidity30d: f.liquidity30d,
      tier: tierOf(f.liquidity30d), configs, breadthHit
    });
  }
  return out;
}

// The latest closed bar's calibrated reading for one coin, printed or not, so
// a coin you hold can show "quiet" as well as "exhausted".
export function latestReading(symbol, bars) {
  if (!Array.isArray(bars) || bars.length < 3) return null;
  const f = surgeFeatures(bars, bars.length - 2);
  if (!f) return null;
  const price = bars[bars.length - 1].close;
  return {
    symbol, at: f.at, price, barPct: f.barPct, volZ: f.volZ, barZ: f.barZ, run24Z: f.run24Z,
    liquidity30d: f.liquidity30d, tier: tierOf(f.liquidity30d)
  };
}

function meanSd(xs) {
  const n = xs.length;
  if (n < 2) return { mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return { mean, sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) };
}

// Market-wide reading at the last closed hour, built the way the research built
// it: an equal-weight index of every coin with a full window (a listing's first
// month is its own regime and stays out), aggregate quote volume across every
// coin, and breadth from each coin's recent prints.
export function marketGauge(barsBySymbol, printsBySymbol = {}, { minCoins = 30, window = 720 } = {}) {
  const byHour = new Map();
  let indexCoins = 0;
  for (const bars of Object.values(barsBySymbol || {})) {
    if (!Array.isArray(bars) || bars.length < 3) continue;
    const closed = bars.slice(0, -1);
    const inIndex = closed.length >= window;
    if (inIndex) indexCoins++;
    for (let i = 0; i < closed.length; i++) {
      const b = closed[i];
      let h = byHour.get(b.openTime);
      if (!h) { h = { qv: 0, retSum: 0, retN: 0 }; byHour.set(b.openTime, h); }
      if (Number.isFinite(b.quoteVolume) && b.quoteVolume > 0) h.qv += b.quoteVolume;
      if (inIndex && i > 0 && closed[i - 1].close > 0 && b.close > 0) {
        h.retSum += Math.max(-0.5, Math.min(0.5, b.close / closed[i - 1].close - 1));
        h.retN++;
      }
    }
  }
  const times = [...byHour.keys()].sort();
  const n = times.length;
  const empty = { at: times[n - 1] || null, scanned: 0, breadth: null, prints24h: 0, aggVolumeZ: null, marketRun72Z: null, marketRet24Pct: null, indexCoins };
  if (n < 2) return empty;
  const logRet = times.map((t) => { const h = byHour.get(t); return h.retN >= minCoins ? Math.log1p(h.retSum / h.retN) : 0; });
  const logIdx = new Array(n).fill(0);
  for (let i = 1; i < n; i++) logIdx[i] = logIdx[i - 1] + logRet[i];
  const lqv = times.map((t) => { const q = byHour.get(t).qv; return q > 0 ? Math.log(q) : null; });
  const lqv24 = lqv.map((_, i) => {
    if (i < 23) return null;
    const w = lqv.slice(i - 23, i + 1);
    return w.every((x) => x != null) ? w.reduce((a, b) => a + b, 0) / 24 : null;
  });
  const t = n - 1;
  const ref = lqv24.slice(Math.max(0, t - 24 - window + 1), Math.max(0, t - 24 + 1)).filter((x) => x != null);
  const v = meanSd(ref);
  const aggVolumeZ = ref.length >= window / 2 && v.sd > 0 && lqv24[t] != null ? (lqv24[t] - v.mean) / v.sd : null;
  const sigWin = logRet.slice(Math.max(1, t - window), t);
  const s = meanSd(sigWin);
  const marketRun72Z = t >= 72 && sigWin.length >= window / 2 && s.sd > 0 ? (logIdx[t] - logIdx[t - 72]) / (s.sd * Math.sqrt(72)) : null;
  const marketRet24Pct = t >= 24 ? (Math.exp(logIdx[t] - logIdx[t - 24]) - 1) * 100 : null;

  let scanned = 0, hitCoins = 0, prints24h = 0;
  for (const [sym, bars] of Object.entries(barsBySymbol || {})) {
    if (!Array.isArray(bars) || bars.length < 400) continue;   // calibrated features need half a window
    scanned++;
    const p = (printsBySymbol[sym] || []).filter((x) => x.breadthHit);
    if (p.length) { hitCoins++; prints24h += p.length; }
  }
  return {
    at: times[t], scanned, indexCoins,
    breadth: scanned ? hitCoins / scanned : null, prints24h,
    aggVolumeZ, marketRun72Z, marketRet24Pct
  };
}

// Plain-language state for the dashboard. It describes what is happening and
// what has historically followed, and it never calls a market top: the
// research found no market-level reading that did.
export function describeGauge(g) {
  if (!g || g.breadth == null) return { state: 'unknown', headline: 'Not enough history yet to read the market.', detail: '' };
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const surge = Number.isFinite(g.aggVolumeZ) && Number.isFinite(g.marketRun72Z)
    && g.aggVolumeZ >= MARKET_SURGE.minVolumeZ && g.marketRun72Z >= MARKET_SURGE.minRun72Z;
  const busy = g.breadth >= BREADTH_REFERENCE.p90;
  const breadthLine = `${pct(g.breadth)} of ${g.scanned} coins printed exhaustion in the last 24 hours (a typical day is ${pct(BREADTH_REFERENCE.median)}).`;
  if (surge) {
    return {
      state: 'surge-in-rally',
      headline: 'The whole market is surging on heavy volume.',
      detail: `${breadthLine} Across the history tested, days like this were followed by more upside for the market as a whole (+${EXHAUSTION_EVIDENCE.market.surgeInRally72}% over 3 days on average), not a top. Exhaustion on individual smaller coins still means what it means.`
    };
  }
  if (busy) {
    return {
      state: 'crowded',
      headline: 'Lots of smaller coins are printing exhaustion at once.',
      detail: `${breadthLine} Each print is a warning for that coin. A crowd of them has not reliably marked a top for the market as a whole.`
    };
  }
  return { state: 'normal', headline: 'Ordinary conditions.', detail: breadthLine };
}

// Hourly closes as a price series, stamped at each bar's CLOSE, plus the
// forming bar's latest price as "now", for the anchored change ladder.
export function priceSeries(bars, nowTs) {
  const s = bars.slice(0, -1).map((b) => ({ ts: Date.parse(b.openTime) + 3_600_000, price: b.close }));
  if (bars.length) s.push({ ts: nowTs, price: bars[bars.length - 1].close });
  return s;
}

export function hourLabel(openTime) {
  return `${new Date(openTime).toISOString().slice(11, 13)}:00 UTC hour`;
}

function runPct(bars, idx, hours) {
  const a = bars[idx - hours];
  return a && a.close > 0 ? (bars[idx].close / a.close - 1) * 100 : null;
}

// The message every exhaustion alert carries: the print with its anchors
// stated, the move since then as a ladder, and what has followed prints like
// it, taken from the measured record for coins of the same size.
export function exhaustionAlertBody(h, bars, gateWhy, { rulesFired = [], nowTs = Date.now() } = {}) {
  const f = h.features;
  const idx = bars.length - 2;
  const tier = tierOf(f.liquidity30d) || 'mid';
  const r24 = runPct(bars, idx, 24);
  const lines = [];
  lines.push(`${h.symbol} ${formatPrice(bars[bars.length - 1].close)} now.`);
  lines.push(`The ${hourLabel(f.at)} closed ${formatPct(f.barPct)} (open to close)`
    + (Number.isFinite(f.volZ) ? ` on volume ${f.volZ.toFixed(1)} standard deviations above its own 30-day norm` : '')
    + ` and ${f.ratio.toFixed(1)}x its 48h median`
    + (r24 != null ? `, after ${formatPct(r24)} over the 24 hours to that close.` : '.'));
  const ladder = formatLadder(changeLadder(priceSeries(bars, nowTs), { nowTs, horizonsMin: [60, 360, 1440] }));
  if (ladder.length) lines.push('Since then and before:', ...ladder);
  lines.push('');
  const both = rulesFired.includes('exhaustion20') && rulesFired.includes('exhaustion_calibrated');
  const kind = both ? 'both' : rulesFired.includes('exhaustion_calibrated') ? 'perCoinOnly' : 'rule20Only';
  if (tier === 'major') {
    lines.push(`This is one of the most liquid coins, and on those a print like this has not reliably been followed by weakness (${formatPct(EXHAUSTION_EVIDENCE.byTier.major.excess24)} against the market over a day). Treat it as a caution, not a sell signal.`);
  } else {
    const ev = EXHAUSTION_EVIDENCE.byCase[`${kind}|${tier}`];
    const size = tier === 'thin' ? 'thin-volume' : 'mid-size';
    const lead = both ? `Strong: both exhaustion rules fired. On ${size} coins that combination` : `On ${size} coins a print like this`;
    lines.push(`${lead} has been followed by trailing the market by ${Math.abs(ev.excess24).toFixed(1)}% over the next day, and the coin fell outright in ${Math.round(ev.fellShare24 * 100)}% of ${ev.n.toLocaleString('en-US')} past cases. In ${Math.round(ev.pokedHigherShare24 * 100)}% of them it first traded higher (median ${formatPct(ev.medianPokeHigher24)}), so there is usually a chance to sell into strength.`);
  }
  lines.push(`Basis: ${gateWhy}. Not financial advice.`);
  return lines.join('\n');
}
