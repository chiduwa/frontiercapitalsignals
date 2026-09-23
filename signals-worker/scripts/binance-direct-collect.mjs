// Collector for the Binance endpoints that are GEO-BLOCKED everywhere else in
// this project's infrastructure.
//
// WHY THIS FILE EXISTS AND WHERE IT MUST RUN
//
// fapi.binance.com and api.binance.com both return HTTP 451 from this
// developer machine and from GitHub-hosted runners (re-verified 2026-09-12).
// data.binance.vision — which serves the same GLOBAL futures market, not
// Binance US — is not blocked, and that is where derivatives_daily and
// asset_liquidity_daily come from. But the portal only publishes files for
// completed days and only for the datasets it chooses to export.
//
// The Oracle Cloud host that runs the trading bot IS NOT geo-blocked. That is
// not an assumption: every one of the 16 rows in trading_bot_entry_intents
// carries a live `mark_price_at_order` read from fapi at decision time. So the
// one machine in this system that can reach the live API is already running,
// already has D1 credentials in /etc/fcs-trading-bot.env, and already has the
// repo checked out at /opt/fcs. This script runs there, on its own systemd
// timer (trading-bot/deploy/fcs-binance-collector.*), and writes what only it
// can fetch.
//
// WHAT IT COLLECTS THAT NOTHING ELSE CAN
//
// Funding-rate HISTORY. funding_rate_daily currently begins 2026-08-02 because
// its only source was a CoinGecko snapshot taken once per build — there is no
// historical funding endpoint on the free tier anywhere, and the portal does
// not export one. /fapi/v1/fundingRate returns the complete settlement history
// per contract, at its applicable settlement cadence, back to listing. That turns a six-week series
// into a multi-year one, which is what `funding_pct` needs to stop being one of
// the XS lane's structurally-dead features.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: COLLECT_FROM_DATE=YYYY-MM-DD to repair truncated old history,
//   BINANCE_FAPI_BASE (default https://fapi.binance.com),
//   COLLECT_SYMBOLS, COLLECT_TIME_BUDGET_MIN (default 20)
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { venueSymbol } from './derivatives-archive.mjs';
import { foldFundingToDaily, fundingResumeTime } from './funding-quality.mjs';
export { foldFundingToDaily } from './funding-quality.mjs';
import { d1, d1Batch, chunk } from './d1-client.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

const FAPI = (process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com').replace(/\/$/, '');
const TIME_BUDGET_MS = Number(process.env.COLLECT_TIME_BUDGET_MIN || 20) * 60000;
const started = Date.now();
const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Binance publishes a weight budget per minute and returns 418/429 when it is
// exceeded. This pace is deliberately gentle: the collector shares the host
// with a live trading bot whose order calls must never be starved or, worse,
// rate-limited behind a backfill.
const PACE_MS = Number(process.env.COLLECT_PACE_MS || 350);

async function fapiJson(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${FAPI}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status === 451 || res.status === 403) {
    throw new Error(`GEOBLOCKED: HTTP ${res.status} from ${FAPI} — this host cannot reach the live Binance API. `
      + 'This script is only meaningful on the Oracle Cloud host; see its header.');
  }
  if (res.status === 429 || res.status === 418) throw new Error(`RATELIMIT: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

// Walk forward in bounded pages. A truncated page stream must NOT publish its
// final calendar day as complete; it may end halfway through that day's events.
export async function fetchFundingHistory(venueSymbol, { startTime = null, maxPages = 40,
  query = fapiJson, budgetExpired = outOfTime, wait = () => sleep(PACE_MS) } = {}) {
  let out = [], cursor = startTime, reachedEnd = false, stopReason = 'page-cap';
  for (let page = 0; page < maxPages; page++) {
    if (budgetExpired()) { stopReason = 'time-budget'; break; }
    const params = { symbol: venueSymbol, limit: 1000 };
    if (cursor) params.startTime = cursor;
    const rows = await query('/fapi/v1/fundingRate', params);
    if (!Array.isArray(rows)) throw new Error('Invalid funding response');
    if (!rows.length) { reachedEnd = true; stopReason = 'end'; break; }
    let maxTime = -Infinity;
    for (const r of rows) {
      if (r.fundingRate == null || String(r.fundingRate).trim() === ''
        || r.fundingTime == null || String(r.fundingTime).trim() === ''
        || (r.symbol && r.symbol !== venueSymbol)) throw new Error('Invalid funding settlement');
      const rate = Number(r.fundingRate), t = Number(r.fundingTime);
      if (!Number.isFinite(rate) || !Number.isFinite(t) || t <= 0) throw new Error('Invalid funding settlement');
      out.push({ time: t, rate }); maxTime = Math.max(maxTime,t);
    }
    if (rows.length < 1000) { reachedEnd = true; stopReason = 'end'; break; }
    if (cursor != null && maxTime < cursor) throw new Error('Funding pagination did not advance');
    cursor = maxTime + 1;
    await wait();
  }
  if (!reachedEnd && out.length) {
    const tailDay = Math.floor(Math.max(...out.map(r => r.time)) / 86400000);
    out = out.filter(r => Math.floor(r.time / 86400000) < tailDay);
  }
  out.completion = { reachedEnd, stopReason };
  return out;
}

async function main() {
  for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}

  console.log(`binance direct collector against ${FAPI}`);
  // Fail fast and LOUDLY if this is not the un-geo-blocked host, rather than
  // writing a partial archive that looks like a supplier outage later.
  try {
    await fapiJson('/fapi/v1/time');
    console.log('reachability: OK — this host can see the live Binance API');
  } catch (e) {
    console.error(String(e && e.message));
    process.exit(2);
  }

  let symbols = process.env.COLLECT_SYMBOLS
    ? process.env.COLLECT_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean)
    : (await d1(env, `SELECT DISTINCT symbol FROM derivatives_daily ORDER BY symbol`)).map((r) => r.symbol);

  // Canonical-table watermark also makes a crash after legacy writes retry
  // missing canonical history rather than skipping it forever.
  // Only fetch what is missing: the earliest date already stored per symbol is
  // the watermark, so a caught-up archive costs one cheap page per symbol.
  const existing = new Map((await d1(env,
    `SELECT symbol, MIN(date) lo, MAX(date) hi FROM funding_settlement_daily
     WHERE source = 'binance-fapi-direct' GROUP BY symbol`)).map((r) => [r.symbol, r]));

  // Favorites first, then oldest watermark first, so a time budget cannot
  // repeatedly starve the tail of the alphabet.
  const favorites = new Set(['BTC','ETH','SOL','XLM','XRP','HYPE','HBAR','ARB']);
  symbols.sort((a,b) => Number(favorites.has(b))-Number(favorites.has(a))
    || String(existing.get(a)?.hi || '').localeCompare(String(existing.get(b)?.hi || '')));
  let done = 0, written = 0, skipped = 0;
  const failures = [];
  for (const symbol of symbols) {
    if (outOfTime()) { console.log(`time budget reached after ${done} symbols — re-run to continue`); break; }
    const venue = venueSymbol(symbol);
    try {
      const have = existing.get(symbol);
      // Re-read the last two stored days; otherwise walk forward from
      // before any USD-M perp existed.
      //
      // An explicit early startTime is REQUIRED for a first fill. With no
      // startTime Binance returns the most RECENT page, and paginating forward
      // from the newest rows is already at the end — the first run collected
      // only 5.5 months per symbol instead of full history, silently, because
      // that looks identical to a young contract. Walking forward from a fixed
      // early anchor gets everything from listing onward.
      const FIRST_PERP_ANCHOR_MS = Date.parse('2019-09-01T00:00:00Z');
      const startTime = fundingResumeTime(have?.hi, FIRST_PERP_ANCHOR_MS, process.env.COLLECT_FROM_DATE);
      const settlements = await fetchFundingHistory(venue, { startTime });
      if (!settlements.completion.reachedEnd) console.log(`${symbol}: ${settlements.completion.stopReason}; incomplete final day withheld, re-run from the repaired watermark`);
      if (!settlements.length) { skipped++; continue; }
      const daily = foldFundingToDaily(settlements);
      if (!daily.length) { skipped++; continue; }
      // COALESCE on open_interest/basis_pct so this never clobbers the columns
      // the CoinGecko snapshot owns — it only fills funding_rate.
      const statements = chunk(daily, 12).map((group) => ({
        sql: `INSERT INTO funding_rate_daily (symbol, date, funding_rate, source) VALUES `
          + group.map(() => '(?, ?, ?, ?)').join(', ')
          + ` ON CONFLICT(symbol, date) DO UPDATE SET funding_rate = excluded.funding_rate, source = excluded.source`,
        params: group.flatMap((d) => [symbol, d.date, d.funding_rate, 'binance-fapi-direct'])
      }));
      // A separate table distinguishes actual daily carry from mean settlement
      // rates and keeps counts/timestamps for quality audits. Apply migration 0043.
      statements.push(...chunk(daily, 10).map(group => ({
        sql: `INSERT INTO funding_settlement_daily
          (symbol,date,rate_sum,rate_mean,settlements,first_time,last_time,source)
          VALUES ${group.map(() => '(?,?,?,?,?,?,?,?)').join(',')}
          ON CONFLICT(symbol,date) DO UPDATE SET rate_sum=excluded.rate_sum,
          rate_mean=excluded.rate_mean,settlements=excluded.settlements,
          first_time=excluded.first_time,last_time=excluded.last_time,source=excluded.source`,
        params: group.flatMap(d => [symbol,d.date,d.funding_sum,d.funding_rate,
          d.settlements,d.first_time,d.last_time,'binance-fapi-direct'])
      })));
      for (const batch of chunk(statements, 40)) await d1Batch(env, batch);
      written += daily.length;
      done++;
      if (done % 20 === 0) console.log(`  ${done}/${symbols.length} symbols, ${written} daily rows`);
      await sleep(PACE_MS);
    } catch (e) {
      const msg = String(e && e.message);
      if (/GEOBLOCKED/.test(msg)) { console.error(msg); process.exit(2); }
      if (/RATELIMIT/.test(msg)) { console.log('rate limited — stopping cleanly, re-run to continue'); break; }
      failures.push(`${symbol}: ${msg.slice(0, 60)}`);
    }
  }
  const tot = await d1(env, `SELECT COUNT(*) n, COUNT(DISTINCT symbol) s, MIN(date) lo, MAX(date) hi
                             FROM funding_rate_daily WHERE funding_rate IS NOT NULL`);
  console.log(`\ndone: ${done} symbols, +${written} daily rows, ${skipped} with no history.`);
  console.log(`funding_rate_daily now ${tot[0].n} rows / ${tot[0].s} symbols / ${tot[0].lo}..${tot[0].hi}`);
  if (failures.length) {
    console.error(`failures (${failures.length}): ${failures.slice(0, 8).join('; ')}`);
    process.exitCode = 1; // Partial source/write failures must not make the timer appear healthy.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
