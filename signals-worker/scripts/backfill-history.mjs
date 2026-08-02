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
import { getCryptoMarkets, getFundingMap, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME, STOCK_WATCHLIST, BENCHMARK_SYMBOLS } from '../worker.js';
import {
  yahooFullHistory, coingeckoDailyBars, getExistingCoverage,
  upsertDailyBars, fundingSnapshotToRows, upsertFundingDaily,
  fearGreedHistory, insertFearGreedHistory
} from './archive.mjs';
import { d1 } from './d1-client.mjs';

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
    .map((c) => ({ symbol: (c.symbol || '').toUpperCase(), id: c.id, assetClass: 'crypto', yahooTicker: `${(c.symbol || '').toUpperCase()}-USD` }));
  const stockUniverse = STOCK_WATCHLIST.map((s) => ({ symbol: s, assetClass: 'stock', yahooTicker: s }));
  // Macro benchmarks (DXY/Gold/Oil) — archived alongside crypto/stocks so
  // they're eligible candidate leaders for the cross-asset lead/lag engine
  // (scripts/daily-refresh.mjs), same as any other asset. Yahoo-only, no
  // CoinGecko fallback applicable (these aren't crypto).
  const benchmarkUniverse = BENCHMARK_SYMBOLS.map((b) => ({ symbol: b.symbol, assetClass: 'benchmark', yahooTicker: b.yahoo }));
  const universe = [...cryptoUniverse, ...stockUniverse, ...benchmarkUniverse];
  console.log(`universe: ${cryptoUniverse.length} crypto + ${stockUniverse.length} stock + ${benchmarkUniverse.length} benchmark = ${universe.length}`);

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
      bars = await yahooFullHistory(a.yahooTicker);
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

  // No deep-history backfill for funding/OI — CoinGecko's /derivatives
  // (see getFundingMap in worker.js, and fundingSnapshotToRows's docs in
  // archive.mjs for why this replaced the original Bybit-history plan) is a
  // live-snapshot-only endpoint with no historical equivalent. This just
  // logs *today's* real snapshot; depth grows one real day at a time from
  // here forward, same as the CoinGecko-fallback slice of the price
  // archive. FUNDING_ROW_BUDGET still applies (caps how many symbols'
  // snapshots get written this run) even though a single day's snapshot is
  // tiny compared to the price leg's multi-year pulls.
  let fundingRowsWritten = 0;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const fundingMap = await getFundingMap();
    const perpSymbols = cryptoUniverse.filter((a) => fundingMap[a.symbol] !== undefined);
    console.log(`${perpSymbols.length} of ${cryptoUniverse.length} crypto assets have derivatives coverage`);
    const wantedMap = Object.fromEntries(perpSymbols.map((a) => [a.symbol, fundingMap[a.symbol]]));
    const rows = fundingSnapshotToRows(wantedMap, today).slice(0, FUNDING_ROW_BUDGET);
    if (rows.length) {
      fundingRowsWritten = await upsertFundingDaily(env, rows);
      rowsWrittenThisRun += fundingRowsWritten;
    }
    console.log(`funding/OI snapshot: wrote today's reading for ${rows.length} symbols`);
  } catch (e) {
    console.error('getFundingMap failed, skipping funding/OI snapshot:', e.message);
  }
  console.log(`funding rows written: ${fundingRowsWritten}`);

  // Fear & Greed deep history: unlike everything else in this script, a
  // single call gets genuinely deep history in one shot (confirmed live —
  // alternative.me's limit=0 returns all 3,101+ daily points back to
  // 2018-02-01) — no pagination, no per-symbol loop, nothing to spread
  // across multiple runs. Checked-and-skipped once it's already in: no
  // point re-fetching+re-inserting thousands of already-stored rows every
  // single day this script runs.
  try {
    const [{ oldest } = {}] = await d1(env, "SELECT MIN(date) AS oldest FROM sentiment_daily WHERE symbol = '' AND fear_greed_altme IS NOT NULL");
    if (oldest && oldest <= '2018-03-01') {
      console.log(`Fear & Greed history already backfilled (earliest stored: ${oldest})`);
    } else {
      const fg = await fearGreedHistory(0);
      const written = await insertFearGreedHistory(env, fg);
      const earliest = fg.reduce((min, r) => (!min || r.date < min ? r.date : min), null);
      console.log(`Fear & Greed history: inserted up to ${written} new daily rows (${fg.length} fetched, back to ${earliest || 'n/a'})`);
    }
  } catch (e) {
    console.error('Fear & Greed history backfill failed:', e.message);
  }

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
