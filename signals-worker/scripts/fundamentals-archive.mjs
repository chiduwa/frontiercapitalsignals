// Fetch + parse for the four fundamentals lanes (migration 0036): order-book
// liquidity, daily supply snapshots, chain activity / macro liquidity, and
// proof-of-work production cost.
//
// Pure parsing functions plus thin fetchers, same split as
// derivatives-archive.mjs.
import { unzipSingleFile, venueSymbol } from './derivatives-archive.mjs';

// ---------------------------------------------------------------------------
// 1. Order-book liquidity (Binance public data portal)
// ---------------------------------------------------------------------------
export const BOOKDEPTH_PORTAL = 'https://data.binance.vision/data/futures/um/daily/bookDepth';

// Aggregates one day of book snapshots into a single row.
//
// Each snapshot emits one line per percentage level. Negative `percentage` is
// below mid (resting BIDS), positive is above (resting ASKS). Averaging
// notional across the day rather than taking a close: a single snapshot of an
// order book is far noisier than a traded price, since a large resting order
// can appear and cancel between samples.
export function aggregateBookDepthCsv(csv, { symbol, venue, date, source = 'binance-data-portal' }) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return null;
  const head = lines[0].split(',').map((h) => h.trim());
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const k of ['timestamp', 'percentage', 'notional']) {
    if (!(k in col)) throw new Error(`bookDepth csv missing column ${k}`);
  }
  // Sum notional per side within each band, per snapshot timestamp, then mean
  // across snapshots. Levels are cumulative per 1% step, so "within 1%" is the
  // single -1/+1 level and "within 5%" sums the five steps on that side.
  const perStamp = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length < head.length) continue;
    const ts = (f[col.timestamp] || '').trim();
    if (ts.slice(0, 10) !== date) continue;
    const pct = Number(f[col.percentage]);
    const notional = Number(f[col.notional]);
    if (!Number.isFinite(pct) || !Number.isFinite(notional) || notional < 0) continue;
    if (!perStamp.has(ts)) perStamp.set(ts, { b1: 0, a1: 0, b5: 0, a5: 0 });
    const s = perStamp.get(ts);
    const abs = Math.abs(pct);
    if (abs > 5) continue;
    if (pct < 0) { s.b5 += notional; if (abs <= 1) s.b1 += notional; }
    else if (pct > 0) { s.a5 += notional; if (abs <= 1) s.a1 += notional; }
  }
  const stamps = [...perStamp.values()];
  if (!stamps.length) return null;
  const mean = (pick) => stamps.reduce((s, x) => s + pick(x), 0) / stamps.length;
  const b1 = mean((x) => x.b1), a1 = mean((x) => x.a1);
  const b5 = mean((x) => x.b5), a5 = mean((x) => x.a5);
  const imb = (b, a) => ((b + a) > 0 ? (b - a) / (b + a) : null);
  return {
    symbol, date, venue_symbol: venue,
    bid_notional_1pct: b1, ask_notional_1pct: a1,
    bid_notional_5pct: b5, ask_notional_5pct: a5,
    book_imbalance_1pct: imb(b1, a1),
    book_imbalance_5pct: imb(b5, a5),
    depth_1pct_usd: b1 + a1,
    snapshots: stamps.length, source
  };
}

export async function fetchBookDepthDay(symbol, date, { timeoutMs = 30000, retries = 2 } = {}) {
  const venue = venueSymbol(symbol);
  const url = `${BOOKDEPTH_PORTAL}/${venue}/${venue}-bookDepth-${date}.zip`;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 404) return null;
      if (res.status === 451 || res.status === 403) throw new Error(`portal blocked: HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return aggregateBookDepthCsv(unzipSingleFile(buf), { symbol, venue, date });
    } catch (e) {
      lastErr = e;
      if (/portal blocked/.test(String(e && e.message))) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 2. Chain activity + macro liquidity (DefiLlama, free)
// ---------------------------------------------------------------------------
const llamaJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

// Per-chain TVL history. One call per chain, so this is run over a short list
// of majors rather than every chain DefiLlama tracks.
export async function fetchChainTvl(chain) {
  const rows = await llamaJson(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`);
  return (rows || [])
    .filter((r) => r && r.tvl > 0 && r.date)
    .map((r) => ({ chain, date: new Date(r.date * 1000).toISOString().slice(0, 10), metric: 'tvl', value: r.tvl }));
}

// Total stablecoin circulating supply, all chains. The standard macro liquidity
// proxy: dry powder entering or leaving crypto as a whole.
export async function fetchStablecoinSupply() {
  const rows = await llamaJson('https://stablecoins.llama.fi/stablecoincharts/all');
  return (rows || [])
    .map((r) => {
      const v = r && r.totalCirculatingUSD;
      const usd = v && typeof v === 'object' ? Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0) : Number(v);
      if (!(usd > 0) || !r.date) return null;
      return { chain: 'ALL', date: new Date(Number(r.date) * 1000).toISOString().slice(0, 10), metric: 'stablecoin_mcap', value: usd };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 3. Production cost (blockchain.info, free, Bitcoin only)
// ---------------------------------------------------------------------------
export async function fetchBtcChart(chartName, timespan = '5years') {
  const url = `https://api.blockchain.info/charts/${chartName}?timespan=${timespan}&format=json&sampled=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${chartName}`);
  const j = await res.json();
  const out = new Map();
  for (const p of (j.values || [])) {
    if (!p || !Number.isFinite(p.y)) continue;
    out.set(new Date(p.x * 1000).toISOString().slice(0, 10), p.y);
  }
  return out;
}

// Merges the four BTC series into one row per date. A date missing any single
// series still produces a row with that column null — the features abstain per
// column rather than dropping the whole day.
export function mergeBtcSeries({ hashrate, difficulty, revenue, transactions }) {
  const dates = new Set([...hashrate.keys(), ...difficulty.keys(), ...revenue.keys(), ...transactions.keys()]);
  return [...dates].sort().map((date) => ({
    network: 'BTC', date,
    hashrate: hashrate.get(date) ?? null,
    difficulty: difficulty.get(date) ?? null,
    miners_revenue_usd: revenue.get(date) ?? null,
    transactions: transactions.has(date) ? Math.round(transactions.get(date)) : null,
    source: 'blockchain.info'
  }));
}
