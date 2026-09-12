// Backfills asset_supply_daily and asset_supply_snapshot (migration 0035).
//
// Circulating supply is derived as market_cap / price from CoinGecko's
// market_chart endpoint, which returns both series over full history in a
// single request per symbol. See the migration for why this is derived rather
// than fetched, and why it is arguably the better measurement than an unlock
// calendar.
//
// Cost: ONE request per symbol for the entire history. That is what makes a
// full backfill practical on the free tier where DefiLlama's unlock API (HTTP
// 402) and CoinGecko's own supply history are both unavailable.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: SUPPLY_DAYS (default 1825), SUPPLY_PACE_MS (default 2600),
//   SUPPLY_SYMBOLS (comma list)
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { getCryptoMarkets } from '../worker.js';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

const DAYS = Number(process.env.SUPPLY_DAYS || 1825);
// MEASURED, not assumed: a 2.6s pace (~23 req/min) was rate-limited into
// total failure on the first run — every symbol 429'd and zero rows were
// written. CoinGecko's free tier from a shared/CI IP range is far tighter than
// its nominal 30/min, and this project has been throttled there before (see
// getFundingMap's retry docs). 9s (~6.5/min) completes 131 symbols in ~20
// minutes, which is a one-time cost for full history.
const PACE_MS = Number(process.env.SUPPLY_PACE_MS || 9000);
// Backoff after a 429 has to be long enough to leave the penalty window, not
// just to re-try into it. 30s/60s/120s, then give up on this symbol so one bad
// coin cannot stall the whole run.
const RATE_LIMIT_BACKOFF_MS = [30000, 60000, 120000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSupplyHistory(id, days = DAYS) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart`
    + `?vs_currency=usd&days=${days}&interval=daily`;
  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      if (attempt === RATE_LIMIT_BACKOFF_MS.length) break;
      await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${id}`);
    const j = await res.json();
    const prices = j.prices || [], caps = j.market_caps || [];
    if (!prices.length || !caps.length) return [];
    // Join on the day stamp rather than by index: the two arrays are normally
    // aligned but nothing in the API guarantees it, and a silent off-by-one
    // would produce a supply series that is wrong by one day's price move.
    const priceByDate = new Map();
    for (const [ts, p] of prices) {
      if (p > 0) priceByDate.set(new Date(ts).toISOString().slice(0, 10), p);
    }
    const out = [];
    for (const [ts, mc] of caps) {
      const date = new Date(ts).toISOString().slice(0, 10);
      const price = priceByDate.get(date);
      if (!(mc > 0) || !(price > 0)) continue;
      out.push({ date, circulating_supply: mc / price, market_cap: mc, price_used: price });
    }
    return out;
  }
  throw new Error(`rate limited repeatedly for ${id}`);
}

async function main() {
  console.log('fetching universe + current supply snapshot...');
  const markets = await getCryptoMarkets();
  const wanted = process.env.SUPPLY_SYMBOLS
    ? new Set(process.env.SUPPLY_SYMBOLS.split(',').map((s) => s.trim().toUpperCase()))
    : new Set((await d1(env, 'SELECT DISTINCT symbol FROM derivatives_daily')).map((r) => r.symbol));

  // symbol -> id, keeping the largest coin when a ticker is reused. Same
  // highest-liquidity tie-break the funding map uses for duplicate perps.
  const chosen = new Map();
  for (const m of markets) {
    const sym = String(m.symbol || '').toUpperCase();
    if (!sym || !wanted.has(sym)) continue;
    const prev = chosen.get(sym);
    if (!prev || (m.market_cap || 0) > (prev.market_cap || 0)) chosen.set(sym, m);
  }
  console.log(`matched ${chosen.size} of ${wanted.size} tracked symbols to a CoinGecko id`);

  const now = new Date().toISOString();
  const snapRows = [...chosen.entries()].map(([sym, m]) => [
    sym, m.id, m.circulating_supply ?? null, m.total_supply ?? null, m.max_supply ?? null, now
  ]);
  for (const group of chunk(snapRows, 14)) {
    await d1Batch(env, [{
      sql: `INSERT OR REPLACE INTO asset_supply_snapshot
            (symbol, coingecko_id, circulating_supply, total_supply, max_supply, as_of)
            VALUES ${group.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
      params: group.flat()
    }]);
  }
  console.log(`snapshot written for ${snapRows.length} symbols`);

  // Resumable: a run that is rate-limited or interrupted must not start over.
  const existing = new Set((await d1(env,
    'SELECT symbol FROM asset_supply_daily GROUP BY symbol HAVING COUNT(*) > 30')).map((r) => r.symbol));
  if (existing.size) console.log(`${existing.size} symbols already stored, skipping them`);

  let done = 0, rows = 0, failed = [], skipped = 0;
  for (const [sym, m] of chosen) {
    if (existing.has(sym)) { skipped++; continue; }
    try {
      const hist = await fetchSupplyHistory(m.id);
      if (hist.length) {
        const statements = chunk(hist, 16).map((group) => ({
          sql: `INSERT OR REPLACE INTO asset_supply_daily
                (symbol, date, circulating_supply, market_cap, price_used, source)
                VALUES ${group.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
          params: group.flatMap((h) => [sym, h.date, h.circulating_supply, h.market_cap, h.price_used, 'coingecko-market-chart'])
        }));
        for (const batch of chunk(statements, 40)) await d1Batch(env, batch);
        rows += hist.length;
      }
      done++;
      if (done % 10 === 0) console.log(`  ${done}/${chosen.size} symbols, ${rows} rows`);
    } catch (e) {
      failed.push(`${sym}: ${String(e && e.message).slice(0, 60)}`);
    }
    await sleep(PACE_MS);
  }
  const tot = await d1(env, 'SELECT COUNT(*) n, COUNT(DISTINCT symbol) s, MIN(date) lo, MAX(date) hi FROM asset_supply_daily');
  console.log(`\ndone: ${done} fetched, ${skipped} already had history, +${rows} rows. archive now ${tot[0].n} rows / ${tot[0].s} symbols / ${tot[0].lo}..${tot[0].hi}`);
  if (failed.length) console.log(`failed (${failed.length}): ${failed.slice(0, 10).join('; ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
