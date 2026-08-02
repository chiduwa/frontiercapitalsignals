// One-time, resumable deep-history backfill into asset_daily_bars and
// funding_rate_daily (see schema.sql). Safe to re-run: only ever writes
// dates not already stored (see getExistingCoverage/upsertDailyBars in
// archive.mjs), so a partial run just picks up where it left off next time
// — triggered manually via workflow_dispatch on
// .github/workflows/signals-backfill.yml until it reports fully caught up.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: BACKFILL_ROW_BUDGET (default 15000 — free-D1-tier-safe;
//   raise once Workers Paid is confirmed active, see the plan)
import { getCryptoMarkets, getFundingMap, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME, STOCK_WATCHLIST } from '../worker.js';
import {
  yahooFullHistory, coingeckoDailyBars, getExistingCoverage,
  upsertDailyBars, bybitFundingHistory, bybitOpenInterest, upsertFundingDaily
} from './archive.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

// Separate budgets for the price leg and the funding/OI leg, not one
// shared pool: a live run confirmed the price leg alone can burn an entire
// 15,000-row budget on just ~5 of the oldest/biggest crypto assets (BTC's
// full history alone is 4,000+ daily bars, iterated first since the
// universe is market-cap-ordered) — sharing one budget meant funding/OI
// silently never got a turn at all, run after run. Each leg now always
// gets to make some progress every invocation.
const PRICE_ROW_BUDGET = Number(process.env.BACKFILL_ROW_BUDGET || 15000);
const FUNDING_ROW_BUDGET = Number(process.env.BACKFILL_FUNDING_ROW_BUDGET || 4000);
let rowsWrittenThisRun = 0;
let priceRowsWritten = 0;
const priceBudgetLeft = () => PRICE_ROW_BUDGET - priceRowsWritten;

async function main() {
  console.log(`backfill-history starting, price budget ${PRICE_ROW_BUDGET}, funding budget ${FUNDING_ROW_BUDGET}`);

  const cryptoRaw = await getCryptoMarkets();
  const cryptoUniverse = cryptoRaw
    .filter((c) => !CRYPTO_BLOCKLIST.has((c.symbol || '').toLowerCase()))
    .filter((c) => (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME)
    .map((c) => ({ symbol: (c.symbol || '').toUpperCase(), id: c.id, assetClass: 'crypto' }));
  const stockUniverse = STOCK_WATCHLIST.map((s) => ({ symbol: s, assetClass: 'stock' }));
  const universe = [...cryptoUniverse, ...stockUniverse];
  console.log(`universe: ${cryptoUniverse.length} crypto + ${stockUniverse.length} stock = ${universe.length}`);

  const coverage = await getExistingCoverage(env, universe.map((u) => u.symbol));

  let yahooOk = 0, cgFallback = 0;
  const priceFailed = [];
  for (const a of universe) {
    if (priceBudgetLeft() <= 0) { console.log('price budget exhausted — stopping price backfill early, resume next run'); break; }
    const existing = coverage[a.symbol];
    const daysSinceMax = existing ? (Date.now() - new Date(existing.maxDate).getTime()) / 86400000 : Infinity;
    // Already caught up (a recent bar + a real amount of depth) — skip
    // re-fetching entirely. This is what makes repeat runs of this same
    // script cheap once the real backfill has landed, not just the D1-write
    // side: no point re-downloading a multi-year Yahoo response just to
    // discard nearly all of it as already-stored.
    if (existing && daysSinceMax < 3 && existing.count >= 300) continue;

    let bars = null, source = null;
    try {
      const ticker = a.assetClass === 'crypto' ? `${a.symbol}-USD` : a.symbol;
      bars = await yahooFullHistory(ticker);
      source = 'yahoo';
      yahooOk++;
    } catch (e) {
      if (a.assetClass === 'crypto') {
        try {
          bars = await coingeckoDailyBars(a.id, 365);
          source = 'coingecko';
          cgFallback++;
        } catch (e2) {
          priceFailed.push(`${a.symbol} (yahoo: ${e.message}; coingecko: ${e2.message})`);
        }
      } else {
        priceFailed.push(`${a.symbol} (yahoo: ${e.message})`);
      }
    }
    if (bars && bars.length) {
      const minExisting = existing ? existing.minDate : null;
      const maxExisting = existing ? existing.maxDate : null;
      const fresh = bars.filter((b) => (!minExisting || b.date < minExisting) || (!maxExisting || b.date > maxExisting));
      if (fresh.length) {
        const toWrite = fresh.slice(0, Math.max(priceBudgetLeft(), 0)).map((b) => ({ symbol: a.symbol, assetClass: a.assetClass, ...b, source }));
        const written = await upsertDailyBars(env, toWrite);
        priceRowsWritten += written;
        rowsWrittenThisRun += written;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`price backfill: yahoo ${yahooOk}, coingecko fallback ${cgFallback}, failed ${priceFailed.length}`);
  if (priceFailed.length) console.log(`  failures: ${priceFailed.join('; ')}`);
  console.log(`price rows written: ${priceRowsWritten}/${PRICE_ROW_BUDGET}`);

  // Independent budget — always gets a turn even when the price leg above
  // (iterated market-cap-first, so BTC/ETH/the biggest, oldest assets go
  // first and can burn an entire shared budget on their own) used all of
  // its own.
  let fundingRowsWritten = 0;
  const fundingBudgetLeft = () => FUNDING_ROW_BUDGET - fundingRowsWritten;
  let fundingMap = {};
  try { fundingMap = await getFundingMap(); } catch (e) { console.error('getFundingMap failed, skipping funding/OI backfill:', e.message); }
  const perpSymbols = cryptoUniverse.filter((a) => fundingMap[a.symbol] !== undefined);
  console.log(`${perpSymbols.length} of ${cryptoUniverse.length} crypto assets have a Bybit perp`);

  let fundingOk = 0;
  const fundingFailed = [];
  const oneYearAgoMs = Date.now() - 365 * 86400000;
  for (const a of perpSymbols) {
    if (fundingBudgetLeft() <= 0) { console.log('funding budget exhausted — stopping funding backfill early, resume next run'); break; }
    const contract = `${a.symbol}USDT`;
    try {
      const [funding, oi] = await Promise.all([
        bybitFundingHistory(contract, oneYearAgoMs),
        bybitOpenInterest(contract).catch((e) => { console.error(`OI failed for ${a.symbol}:`, e.message); return []; })
      ]);
      const byDate = new Map();
      for (const f of funding) byDate.set(f.date, { symbol: a.symbol, date: f.date, fundingRate: f.fundingRate, openInterest: null, source: 'bybit' });
      for (const o of oi) {
        const row = byDate.get(o.date) || { symbol: a.symbol, date: o.date, fundingRate: null, openInterest: null, source: 'bybit' };
        row.openInterest = o.openInterest;
        byDate.set(o.date, row);
      }
      const rows = [...byDate.values()].slice(0, Math.max(fundingBudgetLeft(), 0));
      if (rows.length) {
        const written = await upsertFundingDaily(env, rows);
        fundingRowsWritten += written;
        rowsWrittenThisRun += written;
      }
      fundingOk++;
    } catch (e) {
      fundingFailed.push(`${a.symbol} (${e.message})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`funding/OI backfill: ok ${fundingOk}, failed ${fundingFailed.length}`);
  if (fundingFailed.length) console.log(`  failures: ${fundingFailed.join('; ')}`);
  console.log(`funding rows written: ${fundingRowsWritten}/${FUNDING_ROW_BUDGET}`);

  const finalCoverage = await getExistingCoverage(env, universe.map((u) => u.symbol));
  const depths = Object.values(finalCoverage).map((c) => c.count).sort((a, b) => a - b);
  const totalRows = depths.reduce((a, b) => a + b, 0);
  const covered = Object.keys(finalCoverage).length;
  console.log(`asset_daily_bars: ${covered}/${universe.length} symbols covered, ${totalRows} total rows, median depth ${depths.length ? depths[Math.floor(depths.length / 2)] : 0} days`);
  console.log(covered >= universe.length && priceBudgetLeft() > 0
    ? 'price backfill appears fully caught up — future runs should be near no-ops'
    : 'price backfill not yet complete — re-run (workflow_dispatch) to continue');
  console.log(`total rows written this run: ${rowsWrittenThisRun}`);
}

main().catch((e) => { console.error('backfill-history failed:', e); process.exit(1); });
