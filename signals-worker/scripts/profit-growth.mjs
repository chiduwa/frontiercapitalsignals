// Profit growers: small and mid-sized US companies whose profits are growing.
// User-requested 2026-09-26: "profit seems to drive stock growth and i believe
// small and mid cap companies with relatively growing profits might be gems
// with their own categories to consider."
//
// Tested before it was built (docs/research-2026-09-26/PROFIT_GROWTH.md): 37
// quarterly formation dates, Apr 2017 - Jul 2026, every US filer with SEC data
// and a price. Each quarter uses only filings that were public by then
// (quarter end + 105 days). Headline, against every other stock in the same
// size bucket over the next 13 weeks:
//
//   small caps, top 25 by revenue growth         +1.72%/quarter (t 1.58, both
//     halves positive), +2.97%/quarter since mid-2021 (70% of quarters)
//   mid caps, top 25 by operating-profit growth  +1.99%/quarter (t 2.73, both
//     halves positive, 73% of quarters), +2.66%/quarter since mid-2021
//
// Moderate evidence, not proof, and the page says so. The free price data only
// covers companies still listed today: of the companies filing in mid-2017,
// 57% of the profitable ones are still listed but only 27% of the unprofitable
// ones, so the benchmark is flattered in early years. That bias works AGAINST
// the growers, which is why the recent half, where it is smallest, is quoted.
//
// Sources, all free and keyless: SEC XBRL "frames" (one fact for every filer in
// one call), SEC's ticker map, and Nasdaq's stock screener (every US listing
// with its market cap in one call).
import { d1, d1Batch, chunk, forEachConcurrent } from './d1-client.mjs';

export const SEC_UA = 'FrontierCapitalSignals/1.0 (+https://frontiercapitalsignals.com/signals/)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export const SIZE_BUCKETS = Object.freeze([
  ['micro', 0, 3e8], ['small', 3e8, 2e9], ['mid', 2e9, 1e10], ['large', 1e10, Infinity]
]);
export const LIST_SIZE = 25;
export const MIN_PRICE = 2;
// Median weekly dollar volume over the prior 13 weeks, the backtest's filter:
// about $500K a day, enough to buy and sell a small position.
export const MIN_WEEKLY_DOLLAR_VOLUME = 2.5e6;
// Which growers lead each list. Chosen from six candidates on the backtest and
// the only ones positive in both halves: revenue growth inside small caps,
// operating-profit growth inside mid caps.
export const RANK_BY = Object.freeze({ small: 'revGrowth', mid: 'oiGrowth' });
// The newest quarter must have ended within this many days: a 10-K is due 90
// days after year end, and a quarter-end plus a late filing fits comfortably.
export const MAX_FILING_AGE_DAYS = 200;

export const PROFIT_GROWTH_EVIDENCE = Object.freeze({
  period: 'Apr 2017 to Jul 2026, 37 quarters, every US filer with SEC data and a price',
  small: { perQuarterPct: 1.72, t: 1.58, winShare: 0.65, recentPerQuarterPct: 2.97, recentWinShare: 0.70, heldYearPct: 3.9 },
  mid: { perQuarterPct: 1.99, t: 2.73, winShare: 0.73, recentPerQuarterPct: 2.66, recentWinShare: 0.80, heldYearPct: 1.2 },
  caveats: [
    'Only companies still listed today have prices, and more unprofitable companies disappeared, which flatters the comparison group in early years.',
    'Prices exclude dividends, which profitable companies pay more often.',
    'The ranking was picked from six candidates on the same history.'
  ]
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, headers, { tries = 4, timeoutMs = 30000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 90)}`);
      return await res.json();
    } catch (e) {
      last = e;
      await pause(1500 * (i + 1));
    } finally {
      clearTimeout(t);
    }
  }
  throw last;
}

// ---- pure: quarters ------------------------------------------------------------
const dayNum = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

// Calendar-quarter index (year * 4 + quarter - 1) of a quarter ending on
// `endIso`. A fiscal quarter ending in the first ten days of a month belongs to
// the quarter before it (52/53-week years end on e.g. 2024-12-28 or 2025-01-03).
export function calendarQuarterIndex(endIso) {
  const [y, m, d] = String(endIso).split('-').map(Number);
  let month = m - (d <= 10 ? 1 : 0), year = y;
  if (month === 0) { month = 12; year -= 1; }
  return year * 4 + Math.floor((month - 1) / 3);
}

// 3-month values keyed by calendar quarter, with a missing quarter derived as
// (annual - the three quarters inside that annual period). Matched on the real
// start/end dates, not frame labels: a September fiscal year's fourth quarter
// sits in the CY..Q3 slot, and label arithmetic would subtract the wrong three.
export function quarterlyFromRecords(records) {
  const q = new Map();      // end -> { start, val }
  const annual = [];
  for (const r of records || []) {
    const dur = dayNum(r.end) - dayNum(r.start);
    if (dur >= 80 && dur <= 100) q.set(r.end, { start: r.start, val: Number(r.val) });
    else if (dur >= 350 && dur <= 380) annual.push(r);
  }
  for (const a of annual) {
    const inside = [...q.entries()].filter(([end, v]) => v.start >= a.start && end <= a.end);
    if (inside.length !== 3) continue;
    const coveredEnd = inside.map(([end]) => end).sort().pop();
    if (coveredEnd < a.end && !q.has(a.end)) {
      q.set(a.end, { start: coveredEnd, val: Number(a.val) - inside.reduce((s, [, v]) => s + v.val, 0) });
    }
  }
  const out = new Map();
  for (const [end, v] of q) out.set(calendarQuarterIndex(end), { end, val: v.val });
  return out;
}

// ---- pure: one company's metrics ----------------------------------------------
// ni/rev/oi: Map<cq, {end, val}>. Uses the eight most recent consecutive
// quarters; anything less and the company sits this out.
export function companyMetrics({ ni, rev, oi }) {
  if (!ni || !ni.size) return null;
  const last = Math.max(...ni.keys());
  const qs = Array.from({ length: 8 }, (_, i) => last - i);
  if (!qs.every((k) => ni.has(k))) return null;
  const val = (m, k) => (m && m.has(k) ? m.get(k).val : null);
  const niQ = qs.map((k) => val(ni, k));
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const ttm = sum(niQ.slice(0, 4)), prev = sum(niQ.slice(4));
  const revQ = qs.map((k) => val(rev, k));
  const oiQ = qs.map((k) => val(oi, k));
  const full = (a) => a.every((x) => Number.isFinite(x));
  const revTtm = full(revQ.slice(0, 4)) ? sum(revQ.slice(0, 4)) : null;
  const revPrev = full(revQ.slice(4)) ? sum(revQ.slice(4)) : null;
  const oiTtm = full(oiQ.slice(0, 4)) ? sum(oiQ.slice(0, 4)) : null;
  const oiPrev = full(oiQ.slice(4)) ? sum(oiQ.slice(4)) : null;
  return {
    latestQuarterEnd: ni.get(last).end,
    ttmNi: ttm, prevNi: prev,
    niGrowth: prev !== 0 ? (ttm - prev) / Math.abs(prev) : null,
    yoyUp: [0, 1, 2, 3].filter((i) => niQ[i] > niQ[i + 4]).length,
    profitableQuarters: niQ.slice(0, 4).filter((x) => x > 0).length,
    revTtm, revGrowth: revPrev > 0 && revTtm != null ? revTtm / revPrev - 1 : null,
    oiTtm, oiPrev, oiGrowth: oiTtm != null && oiPrev ? (oiTtm - oiPrev) / Math.abs(oiPrev) : null,
    netMargin: revTtm > 0 ? ttm / revTtm : null
  };
}

export function sizeBucket(mcap) {
  for (const [name, lo, hi] of SIZE_BUCKETS) if (mcap >= lo && mcap < hi) return name;
  return null;
}

// Every company on a list is actually making money (net profit over the last
// four quarters above zero) with revenue growing, and passes either screen:
//   consistent: profitable all four quarters, profit up on a year earlier in at
//               least three of them
//   operating:  operating profit positive both years and up 20%+
// Revenue more than quadrupling is left out: at that size it is almost always
// an acquisition or a restated segment, not the business growing. Both rules
// were tested before adoption and improved or held the result (mid caps
// +1.51 -> +1.99%/quarter; small caps +2.11 -> +1.72%, still positive in both
// halves), and they match what "profit growers" means to a reader.
export const MAX_REVENUE_GROWTH = 3;

export function qualifies(m) {
  if (!m || !(m.ttmNi > 0) || !(m.revGrowth > 0) || m.revGrowth > MAX_REVENUE_GROWTH) return false;
  const consistent = m.profitableQuarters === 4 && m.yoyUp >= 3;
  const operating = m.oiTtm > 0 && m.oiPrev > 0 && m.oiGrowth >= 0.20;
  return consistent || operating;
}

// The screener lists preferred shares, notes and units next to common stock,
// and a preferred class's "market cap" is not the company's.
export function isCommonStock(name) {
  return !/preferred|depositary|warrant|\bunits?\b|\bnotes?\b|\brights?\b|debenture|\bpfd\b/i.test(String(name || ''));
}

export function whyItQualifies(m) {
  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
  const parts = [];
  if (m.oiTtm > 0 && m.oiPrev > 0 && m.oiGrowth >= 0.20) parts.push(`operating profit ${pct(m.oiGrowth)} on revenue ${pct(m.revGrowth)}`);
  if (m.profitableQuarters === 4 && m.yoyUp >= 3) parts.push(`profitable every quarter, up on a year earlier in ${m.yoyUp} of the last 4`);
  return parts.join('; ');
}

// ---- pure: the lists ------------------------------------------------------------
// companies: [{ symbol, name, sector, industry, price, mcap, metrics, liquidity }]
// where liquidity (median weekly dollar volume) may be null if not measured.
export function buildLists(companies, { size = LIST_SIZE } = {}) {
  const lists = {};
  for (const bucket of ['small', 'mid']) {
    const key = RANK_BY[bucket];
    lists[bucket] = companies
      .filter((c) => sizeBucket(c.mcap) === bucket && c.price >= MIN_PRICE && qualifies(c.metrics))
      .filter((c) => c.liquidity == null || c.liquidity >= MIN_WEEKLY_DOLLAR_VOLUME)
      .filter((c) => Number.isFinite(c.metrics[key]) && isCommonStock(c.name))
      .sort((a, b) => (b.metrics[key] - a.metrics[key]) || ((b.metrics.niGrowth ?? -Infinity) - (a.metrics.niGrowth ?? -Infinity)))
      .slice(0, size)
      .map((c, i) => ({ rank: i + 1, ...c, why: whyItQualifies(c.metrics), pe: c.metrics.ttmNi > 0 ? c.mcap / c.metrics.ttmNi : null }));
  }
  return lists;
}

// Median weekly dollar volume over the last 13 weeks from daily rows
// [{date, close, volume}].
export function medianWeeklyDollarVolume(rows) {
  const weeks = new Map();
  for (const r of rows || []) {
    if (!(r.close > 0) || !(r.volume >= 0)) continue;
    const d = new Date(`${r.date}T00:00:00Z`);
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const k = monday.toISOString().slice(0, 10);
    weeks.set(k, (weeks.get(k) || 0) + r.close * r.volume);
  }
  const vals = [...weeks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-13).map(([, v]) => v).sort((a, b) => a - b);
  return vals.length >= 8 ? vals[Math.floor(vals.length / 2)] : null;
}

// A cohort's record: equal-weight return of the list against the equal-weight
// return of every stock in the same bucket, from the same two prices. Each
// stock's return is clipped at -100%/+300% as in the backtest.
export function cohortExcess(listRows, bucketRows, priceNow) {
  const ret = (p0, p1) => Math.max(-1, Math.min(3, p1 / p0 - 1));
  const r = (rows) => rows.map((x) => (x.price > 0 && priceNow[x.symbol] > 0 ? ret(x.price, priceNow[x.symbol]) : null)).filter((x) => x != null);
  const a = r(listRows), b = r(bucketRows);
  if (a.length < 5 || b.length < 20) return null;
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return { n: a.length, bucketN: b.length, listPct: mean(a) * 100, bucketPct: mean(b) * 100, excessPct: (mean(a) - mean(b)) * 100 };
}

export function summarizeLive(outcomes) {
  const out = {};
  for (const o of outcomes || []) {
    const k = `${o.list}|${o.horizon_days}`;
    (out[k] ??= []).push(Number(o.excess_pct));
  }
  return Object.fromEntries(Object.entries(out).map(([k, xs]) => {
    const n = xs.length, mean = xs.reduce((s, x) => s + x, 0) / n;
    return [k, { cohorts: n, meanExcessPct: mean, winShare: xs.filter((x) => x > 0).length / n }];
  }));
}

// ---- IO: sources ------------------------------------------------------------------
export async function fetchScreener() {
  const j = await fetchJson('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true',
    { 'User-Agent': BROWSER_UA, Accept: 'application/json' });
  const num = (s) => { const v = parseFloat(String(s ?? '').replace(/[$,%]/g, '')); return Number.isFinite(v) ? v : null; };
  return ((j && j.data && j.data.rows) || [])
    .filter((r) => /^[A-Z]{1,5}$/.test(String(r.symbol || '').trim()))
    .map((r) => ({ symbol: r.symbol.trim(), name: r.name, price: num(r.lastsale), mcap: num(r.marketCap),
      volume: num(r.volume), sector: r.sector || null, industry: r.industry || null, country: r.country || null }));
}

export async function fetchSecTickers() {
  const j = await fetchJson('https://www.sec.gov/files/company_tickers_exchange.json', { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' });
  const bySymbol = new Map();
  for (const [cik, name, ticker] of (j && j.data) || []) if (ticker && !bySymbol.has(ticker.toUpperCase())) bySymbol.set(ticker.toUpperCase(), cik);
  return bySymbol;
}

async function frame(tag, unit, period) {
  const j = await fetchJson(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/${unit}/${period}.json`,
    { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' });
  return (j && j.data) || [];
}

// Every filer's records for one tag over the last `quarters` quarters plus the
// annual frames needed to derive fourth quarters. ~14 requests per tag.
export async function fetchTagHistory(tag, { now = new Date(), quarters = 11, years = 3 } = {}) {
  const periods = [];
  let y = now.getUTCFullYear(), q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < quarters; i++) {
    q -= 1; if (q === 0) { q = 4; y -= 1; }
    periods.push(`CY${y}Q${q}`);
  }
  // The current year too: a fiscal year ending mid-year can be filed under it.
  for (let i = 0; i <= years; i++) periods.push(`CY${now.getUTCFullYear() - i}`);
  const byCik = new Map();
  for (const p of periods) {
    let rows = [];
    try { rows = await frame(tag, 'USD', p); } catch (e) { console.log(`  ${tag} ${p}: ${e.message}`); }
    for (const r of rows) (byCik.get(r.cik) || byCik.set(r.cik, []).get(r.cik)).push({ start: r.start, end: r.end, val: r.val });
    await pause(250);   // SEC fair access: 10 req/s ceiling, this stays at ~3
  }
  return byCik;
}

// 13 weeks of daily bars for one symbol, Yahoo first (it answers GitHub's
// runners), Nasdaq's quote API second. Once Yahoo rate-limits a run it is not
// asked again in that run: each further attempt would only add its retry wait
// to every remaining symbol.
let yahooBlocked = false;
export async function fetchRecentDaily(symbol) {
  if (!yahooBlocked) try {
    const now = Math.floor(Date.now() / 1000);
    const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${now - 130 * 86400}&period2=${now}&interval=1d`,
      { 'User-Agent': BROWSER_UA }, { tries: 1 });
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
    if (r && r.timestamp && q) {
      return r.timestamp.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: q.close[i], volume: q.volume[i] }))
        .filter((x) => x.close > 0);
    }
  } catch (e) {
    if (/HTTP 429/.test(String(e && e.message))) yahooBlocked = true;
  }
  const from = new Date(Date.now() - 130 * 86400000).toISOString().slice(0, 10);
  const j = await fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${from}&limit=200&todate=${new Date().toISOString().slice(0, 10)}`,
    { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, { tries: 2 });
  const rows = (j && j.data && j.data.tradesTable && j.data.tradesTable.rows) || [];
  const num = (s) => parseFloat(String(s).replace(/[$,]/g, ''));
  return rows.map((r) => {
    const [m, d, y] = String(r.date).split('/');
    return { date: `${y}-${m}-${d}`, close: num(r.close), volume: num(r.volume) };
  }).filter((x) => x.close > 0);
}

// ---- IO: the daily job ------------------------------------------------------------
export async function runProfitGrowth(env, { now = new Date(), dryRun = false, log = console.log } = {}) {
  const asOf = now.toISOString().slice(0, 10);
  const [screener, cikBySymbol] = await Promise.all([fetchScreener(), fetchSecTickers()]);
  log(`profit-growth: ${screener.length} listed stocks, ${cikBySymbol.size} SEC tickers`);
  const tags = {
    ni: await fetchTagHistory('NetIncomeLoss', { now }),
    oi: await fetchTagHistory('OperatingIncomeLoss', { now }),
    rev: await fetchTagHistory('Revenues', { now }),
    rfc: await fetchTagHistory('RevenueFromContractWithCustomerExcludingAssessedTax', { now })
  };
  // One ticker per company: the most traded listing of it.
  const byCik = new Map();
  for (const s of screener) {
    const cik = cikBySymbol.get(s.symbol);
    if (!cik) continue;
    const prior = byCik.get(cik);
    if (!prior || (s.volume || 0) > (prior.volume || 0)) byCik.set(cik, s);
  }
  const companies = [];
  for (const [cik, s] of byCik) {
    const ni = quarterlyFromRecords(tags.ni.get(cik));
    if (!ni.size) continue;
    const rev = quarterlyFromRecords(tags.rev.get(cik));
    for (const [k, v] of quarterlyFromRecords(tags.rfc.get(cik))) if (!rev.has(k)) rev.set(k, v);   // "Revenues" wins where both exist
    const metrics = companyMetrics({ ni, rev, oi: quarterlyFromRecords(tags.oi.get(cik)) });
    if (!metrics || !(s.mcap > 0)) continue;
    // A company that has stopped filing keeps its last eight quarters in the
    // frames forever; a year-old picture of profit growth is not one.
    if ((now.getTime() - Date.parse(`${metrics.latestQuarterEnd}T00:00:00Z`)) / 86400000 > MAX_FILING_AGE_DAYS) continue;
    companies.push({ cik, symbol: s.symbol, name: s.name, sector: s.sector, industry: s.industry, price: s.price, mcap: s.mcap, metrics, liquidity: null });
  }
  log(`profit-growth: ${companies.length} companies with eight consecutive quarters`);

  // Liquidity is measured only where it decides something: the leading
  // qualifiers in each bucket, before the cut to the final list.
  const pre = buildLists(companies, { size: 70 });
  const candidates = [...pre.small, ...pre.mid];
  await forEachConcurrent(candidates, 4, async (c) => {
    try { c.liquidity = medianWeeklyDollarVolume(await fetchRecentDaily(c.symbol)); }
    catch { c.liquidity = null; }
    await pause(150);
  });
  const bySymbol = new Map(candidates.map((c) => [c.symbol, c]));
  for (const c of companies) if (bySymbol.has(c.symbol)) c.liquidity = bySymbol.get(c.symbol).liquidity ?? 0;
  const lists = buildLists(companies.filter((c) => bySymbol.has(c.symbol) && c.liquidity > 0));
  log(`profit-growth: small ${lists.small.length}, mid ${lists.mid.length} (from ${candidates.length} liquidity-checked candidates)`);
  if (dryRun) return { asOf, lists, companies };

  const listRows = Object.entries(lists).flatMap(([list, rows]) => rows.map((r) => ({ list, ...r })));
  for (const part of chunk(listRows, 10)) {
    await d1Batch(env, part.map((r) => ({
      sql: `INSERT INTO profit_growth_screen (as_of, list, rank, symbol, name, sector, industry, price, mcap, ttm_ni, ni_growth,
              rev_growth, oi_growth, yoy_up, profitable_quarters, net_margin, pe, latest_quarter_end, liquidity, why)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(as_of, list, symbol) DO UPDATE SET rank=excluded.rank, price=excluded.price, mcap=excluded.mcap,
              ttm_ni=excluded.ttm_ni, ni_growth=excluded.ni_growth, rev_growth=excluded.rev_growth, oi_growth=excluded.oi_growth,
              yoy_up=excluded.yoy_up, profitable_quarters=excluded.profitable_quarters, net_margin=excluded.net_margin,
              pe=excluded.pe, latest_quarter_end=excluded.latest_quarter_end, liquidity=excluded.liquidity, why=excluded.why`,
      params: [asOf, r.list, r.rank, r.symbol, r.name, r.sector, r.industry, r.price, r.mcap, r.metrics.ttmNi, r.metrics.niGrowth,
        r.metrics.revGrowth, r.metrics.oiGrowth, r.metrics.yoyUp, r.metrics.profitableQuarters, r.metrics.netMargin, r.pe,
        r.metrics.latestQuarterEnd, r.liquidity, r.why]
    })));
  }

  // Profit facts for every listed company, so the existing stock screens can
  // show them next to their own rows (one upsert per company).
  for (const part of chunk(companies, 40)) {
    await d1Batch(env, part.map((c) => ({
      sql: `INSERT INTO company_profit_metrics (symbol, as_of, bucket, mcap, ttm_ni, ni_growth, rev_growth, oi_growth, yoy_up,
              profitable_quarters, net_margin, latest_quarter_end, qualifies)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol) DO UPDATE SET as_of=excluded.as_of, bucket=excluded.bucket, mcap=excluded.mcap, ttm_ni=excluded.ttm_ni,
              ni_growth=excluded.ni_growth, rev_growth=excluded.rev_growth, oi_growth=excluded.oi_growth, yoy_up=excluded.yoy_up,
              profitable_quarters=excluded.profitable_quarters, net_margin=excluded.net_margin,
              latest_quarter_end=excluded.latest_quarter_end, qualifies=excluded.qualifies`,
      params: [c.symbol, asOf, sizeBucket(c.mcap), c.mcap, c.metrics.ttmNi, c.metrics.niGrowth, c.metrics.revGrowth, c.metrics.oiGrowth,
        c.metrics.yoyUp, c.metrics.profitableQuarters, c.metrics.netMargin, c.metrics.latestQuarterEnd, qualifies(c.metrics) ? 1 : 0]
    })));
  }

  // The comparison group, once a week: every small and mid-cap listing and its
  // price, so each week's lists can later be judged against their own buckets.
  const monday = new Date(now); monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  const have = await d1(env, 'SELECT 1 FROM profit_growth_benchmark WHERE as_of >= ? LIMIT 1', [weekStart]);
  if (!have.length) {
    const bench = screener.filter((s) => ['small', 'mid'].includes(sizeBucket(s.mcap)) && s.price >= MIN_PRICE);
    for (const part of chunk(bench, 50)) {
      await d1Batch(env, part.map((s) => ({
        sql: 'INSERT OR IGNORE INTO profit_growth_benchmark (as_of, bucket, symbol, price) VALUES (?,?,?,?)',
        params: [asOf, sizeBucket(s.mcap), s.symbol, s.price]
      })));
    }
    log(`profit-growth: weekly comparison snapshot, ${bench.length} small/mid listings`);
  }

  // Score every weekly cohort whose horizon has passed, at today's prices.
  const priceNow = Object.fromEntries(screener.map((s) => [s.symbol, s.price]));
  const cohorts = await d1(env, 'SELECT DISTINCT as_of FROM profit_growth_benchmark ORDER BY as_of');
  const done = new Set((await d1(env, 'SELECT cohort, list, horizon_days FROM profit_growth_outcomes'))
    .map((r) => `${r.cohort}|${r.list}|${r.horizon_days}`));
  let scored = 0;
  for (const { as_of: cohort } of cohorts) {
    for (const horizon of [28, 91, 182]) {
      const age = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${cohort}T00:00:00Z`)) / 86400000;
      if (age < horizon) continue;
      for (const list of ['small', 'mid']) {
        if (done.has(`${cohort}|${list}|${horizon}`)) continue;
        const members = await d1(env, 'SELECT symbol, price FROM profit_growth_screen WHERE as_of = ? AND list = ?', [cohort, list]);
        const bench = await d1(env, 'SELECT symbol, price FROM profit_growth_benchmark WHERE as_of = ? AND bucket = ?', [cohort, list]);
        const r = cohortExcess(members, bench, priceNow);
        if (!r) continue;
        await d1(env, `INSERT OR IGNORE INTO profit_growth_outcomes (cohort, list, horizon_days, n, bucket_n, list_pct, bucket_pct, excess_pct, scored_on)
          VALUES (?,?,?,?,?,?,?,?,?)`, [cohort, list, horizon, r.n, r.bucketN, r.listPct, r.bucketPct, r.excessPct, asOf]);
        scored++;
      }
    }
  }
  log(`profit-growth: ${listRows.length} list rows, ${companies.length} company metrics, ${scored} cohort outcome(s) scored`);
  return { asOf, lists, companies };
}

// ---- payload loader (build-signals.mjs) -------------------------------------------
export async function loadProfitGrowth(env, nowMs = Date.now(), query = d1) {
  const latest = await query(env, 'SELECT MAX(as_of) AS as_of FROM profit_growth_screen');
  const asOf = latest[0] && latest[0].as_of;
  if (!asOf) return { status: 'awaiting-first-run', evidence: PROFIT_GROWTH_EVIDENCE };
  const rows = await query(env, `SELECT list, rank, symbol, name, sector, industry, price, mcap, ttm_ni, ni_growth, rev_growth, oi_growth,
      yoy_up, profitable_quarters, net_margin, pe, latest_quarter_end, why FROM profit_growth_screen WHERE as_of = ? ORDER BY list, rank`, [asOf]);
  const outcomes = await query(env, 'SELECT list, horizon_days, excess_pct FROM profit_growth_outcomes');
  const lists = { small: [], mid: [] };
  for (const r of rows) (lists[r.list] ||= []).push(r);
  const ageDays = (nowMs - Date.parse(`${asOf}T00:00:00Z`)) / 86400000;
  return { status: ageDays <= 4 ? 'live' : 'stale', asOf, lists, live: summarizeLive(outcomes), evidence: PROFIT_GROWTH_EVIDENCE };
}

// Profit facts for the equities already on the screens.
export async function loadCompanyProfitMetrics(env, symbols, query = d1) {
  const out = {};
  for (const part of chunk([...new Set(symbols)], 90)) {
    const rows = await query(env, `SELECT symbol, as_of, bucket, ttm_ni, ni_growth, rev_growth, oi_growth, yoy_up, profitable_quarters,
        net_margin, latest_quarter_end, qualifies FROM company_profit_metrics WHERE symbol IN (${part.map(() => '?').join(',')})`, part);
    for (const r of rows) out[r.symbol] = r;
  }
  return out;
}

// Invoked daily by .github/workflows/signals-profit-growth.yml. Guarded so the
// test suite can import the pure functions without running a job.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const env = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID
  };
  const dryRun = process.env.PROFIT_GROWTH_DRY_RUN === '1';
  if (!dryRun) {
    for (const [name, v] of Object.entries(env)) {
      if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
    }
  }
  runProfitGrowth(env, { dryRun }).catch((e) => { console.error('profit-growth failed:', e); process.exit(1); });
}
