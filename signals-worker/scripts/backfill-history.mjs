// One-time, resumable deep-history backfill into asset_daily_bars and
// funding_rate_daily (see schema.sql). Safe to re-run: only ever writes
// dates not already stored (see getExistingCoverage/upsertDailyBars in
// archive.mjs), so a partial run just picks up where it left off next time
// — triggered manually via workflow_dispatch on
// .github/workflows/signals-backfill.yml until it reports fully caught up.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: BACKFILL_ROW_BUDGET (default 15000 — free-D1-tier-safe;
//   raise once Workers Paid is confirmed active, see the plan),
//   BINANCE_ROW_BUDGET (default 15000, same reasoning)
import { getCryptoMarkets, getFundingMap, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME, STOCK_WATCHLIST, BENCHMARK_SYMBOLS, computeTimeOfDayTallies } from '../worker.js';
import {
  yahooFullHistory, coingeckoDailyBars, getExistingCoverage,
  upsertDailyBars, fundingSnapshotToRows, upsertFundingDaily,
  fearGreedHistory, insertFearGreedHistory,
  yahooHourlyBars, computeSwingTimeTallies, upsertSwingTimeStats, getSwingTimeCoverage,
  upsertTimeOfDayStats, getTimeOfDayCoverage, getOpenCoverage,
  binanceUsExchangeInfo, binanceUsKlines, getExistingHourlyCoverage, upsertHourlyBars,
  isYahooCryptoDataTrustworthy
} from './archive.mjs';
import { selectIntradayWatchlist } from './intraday.mjs';
import { d1 } from './d1-client.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;

// A symbol whose busiest 1h slot already holds this many observations has been
// bootstrapped. Yahoo's hourly window is ~730 calendar days, which is ~500
// trading sessions for an equity and ~730 for 24/7 crypto, so 300 clears a
// genuine first bootstrap while still blocking every repeat.
const TOD_BOOTSTRAP_COVERAGE_TARGET = 300;
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
// Own budget, not shared with the price leg above — same reasoning: a
// symbol's own full-depth pull shouldn't be able to starve every other
// symbol's turn. Binance.US's own history floor (~2019-09-23, confirmed
// live — see binanceUsKlines' docs, archive.mjs).
const BINANCE_ROW_BUDGET = Number(process.env.BINANCE_ROW_BUDGET || 15000);
// Caps how much of the shared budget any ONE symbol can consume in a
// single run — confirmed live this was a real problem, not a theoretical
// one: the watchlist is sorted by open interest descending, and BTC's own
// full ~6-year depth (~60,000 hourly bars) alone consumed 14,962 of a
// 15,000-row run on its own, leaving every other symbol untouched. At
// ~3,000/symbol, one run makes real progress on ~5 symbols instead of
// fully draining the budget on the single largest one.
const BINANCE_PER_SYMBOL_ROW_CAP = Number(process.env.BINANCE_PER_SYMBOL_ROW_CAP || 3000);
const BINANCE_US_FLOOR_MS = new Date('2019-09-23T00:00:00Z').getTime();
let rowsWrittenThisRun = 0;
let priceRowsWritten = 0;
const priceBudgetLeft = () => PRICE_ROW_BUDGET - priceRowsWritten;

async function main() {
  console.log(`backfill-history starting, price budget ${PRICE_ROW_BUDGET}, funding budget ${FUNDING_ROW_BUDGET}`);

  const cryptoRaw = await getCryptoMarkets();
  const cryptoUniverse = cryptoRaw
    .filter((c) => !CRYPTO_BLOCKLIST.has((c.symbol || '').toLowerCase()))
    .filter((c) => (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME)
    .map((c) => ({ symbol: (c.symbol || '').toUpperCase(), id: c.id, assetClass: 'crypto', yahooTicker: `${(c.symbol || '').toUpperCase()}-USD`, refPrice: c.current_price ?? null }));
  const stockUniverse = STOCK_WATCHLIST.map((s) => ({ symbol: s, assetClass: 'stock', yahooTicker: s }));
  // Macro benchmarks (DXY/Gold/Oil) — archived alongside crypto/stocks so
  // they're eligible candidate leaders for the cross-asset lead/lag engine
  // (scripts/daily-refresh.mjs), same as any other asset. Yahoo-only, no
  // CoinGecko fallback applicable (these aren't crypto).
  const benchmarkUniverse = BENCHMARK_SYMBOLS.map((b) => ({ symbol: b.symbol, assetClass: 'benchmark', yahooTicker: b.yahoo }));
  // Benchmarks first, not last: found live — the crypto leg alone can burn
  // an entire run's row budget on deep-history assets (see PRICE_ROW_BUDGET's
  // own docs above), so a benchmark placed at the end of the universe could
  // wait indefinitely if crypto/stock churn (new coins rotating into the
  // top-N, needing a fresh full pull) keeps consuming the budget first
  // every single run. Benchmarks are a small, fixed, one-time-per-symbol
  // cost (5 symbols, full history pulled once each) — putting them first
  // means they always complete on the very next run regardless of
  // whatever's happening with the much larger, recurring crypto/stock cost
  // behind them.
  const universe = [...benchmarkUniverse, ...cryptoUniverse, ...stockUniverse];
  console.log(`universe: ${cryptoUniverse.length} crypto + ${stockUniverse.length} stock + ${benchmarkUniverse.length} benchmark = ${universe.length}`);

  const coverage = await getExistingCoverage(env, universe.map((u) => u.symbol));
  // BACKFILL_OPEN=1 forces a one-time re-pull for symbols that have no open
  // price yet. Needed because the caught-up gate below asks only "do we have
  // recent bars", which stayed true for every symbol after `open` was added,
  // so the column would have remained NULL on all ~694k rows forever.
  // Env-gated rather than automatic: a symbol whose bars come from the
  // CoinGecko fallback will never have an open, and an automatic rule would
  // re-fetch those on every single run for eternity.
  const backfillOpen = String(process.env.BACKFILL_OPEN || '').toLowerCase() === '1'
    || String(process.env.BACKFILL_OPEN || '').toLowerCase() === 'true';
  const openCoverage = backfillOpen ? await getOpenCoverage(env) : {};
  if (backfillOpen) {
    const missing = universe.filter((a) => !(openCoverage[a.symbol] > 0)).length;
    console.log(`BACKFILL_OPEN set: ${missing} of ${universe.length} symbols have no open price yet and will be re-pulled`);
  }

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
    const needsOpen = backfillOpen && !(openCoverage[a.symbol] > 0);
    if (existing && daysSinceMax < 3 && existing.count >= 300 && !needsOpen) continue;

    let bars = null, source = null;
    try {
      const yahooBars = await yahooFullHistory(a.yahooTicker);
      if (a.assetClass === 'crypto' && !isYahooCryptoDataTrustworthy(yahooBars, a.refPrice, Date.now())) {
        throw new Error(`Yahoo ${a.yahooTicker} looks like the wrong asset (stale or off by an order of magnitude vs CoinGecko's current price) — treating as a fetch failure`);
      }
      bars = yahooBars;
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
        if (written) {
          const writtenDates = toWrite.map((b) => b.date);
          const newMin = writtenDates.reduce((m, d) => (m === null || d < m ? d : m), minExisting);
          const newMax = writtenDates.reduce((m, d) => (m === null || d > m ? d : m), maxExisting);
          coverage[a.symbol] = { minDate: newMin, maxDate: newMax, count: (existing ? existing.count : 0) + written };
        }
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
  // across multiple runs. Freshness-gated the same way the price leg
  // gates re-fetches (daysSinceMax above): skip only while the stored
  // MAX(date) is recent. A fixed MIN(date) <= 2018-03-01 check used to
  // gate this instead — since that's permanently true after the first
  // successful run, it silently stopped this leg from ever running again
  // (harmless in practice only because build-signals.mjs separately keeps
  // today's row fresh via its own independent hourly write).
  try {
    const [{ newest } = {}] = await d1(env, "SELECT MAX(date) AS newest FROM sentiment_daily WHERE symbol = '' AND fear_greed_altme IS NOT NULL");
    const daysSinceNewest = newest ? (Date.now() - new Date(newest).getTime()) / 86400000 : Infinity;
    if (newest && daysSinceNewest < 3) {
      console.log(`Fear & Greed history already fresh (latest stored: ${newest})`);
    } else {
      const fg = await fearGreedHistory(0);
      const written = await insertFearGreedHistory(env, fg);
      const earliest = fg.reduce((min, r) => (!min || r.date < min ? r.date : min), null);
      console.log(`Fear & Greed history: inserted up to ${written} new daily rows (${fg.length} fetched, back to ${earliest || 'n/a'})`);
    }
  } catch (e) {
    console.error('Fear & Greed history backfill failed:', e.message);
  }

  // Swing-time-of-day bootstrap: ~2 real years of Yahoo hourly bars per
  // symbol, tallied into which slots hold each day's high/low (see
  // computeSwingTimeTallies's docs) — a distinct budget from the price/
  // funding legs above, since the persisted footprint here is tiny
  // regardless of how many symbols get processed (a few hundred rows per
  // symbol, not raw hourly bars) — the real cost is the Yahoo fetch itself,
  // paced accordingly. getSwingTimeCoverage lets repeat runs skip symbols
  // already well-bootstrapped rather than re-fetching 700 days every time.
  try {
    const swingCoverage = await getSwingTimeCoverage(env);
    let swingOk = 0, swingSkipped = 0, todBootstrapped = 0, todSkipped = 0;
    const swingFailed = [];
    for (const a of universe) {
      if (a.assetClass === 'benchmark') continue; // no swing-timing story for macro benchmarks — nothing trades them directly
      if ((swingCoverage[a.symbol] || 0) >= 600) { swingSkipped++; continue; }
      try {
        const bars = await yahooHourlyBars(a.yahooTicker);
        const { tallies, totalDays } = computeSwingTimeTallies(bars);
        if (totalDays > 0) await upsertSwingTimeStats(env, a.symbol, a.assetClass, tallies, totalDays, new Date().toISOString());
        // Reuses the exact same already-fetched `bars` — this is the
        // "zero new fetches" time-of-day bootstrap (see computeTimeOfDayTallies's
        // docs in worker.js): everywhere this loop already gives a symbol
        // real hourly depth for swing-timing also feeds time_of_day_stats,
        // the table the live timeOfDaySignal technique reads.
        const todTallies = computeTimeOfDayTallies(bars);
        if (Object.keys(todTallies).length) {
          await upsertTimeOfDayStats(env, a.symbol, a.assetClass, todTallies, new Date().toISOString());
          todBootstrapped++;
        }
        swingOk++;
      } catch (e) {
        swingFailed.push(`${a.symbol} (${e.message})`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`swing-time backfill: ok ${swingOk}, already covered ${swingSkipped}, failed ${swingFailed.length}`);
    console.log(`time-of-day bootstrap (same fetch, no new cost): ${todBootstrapped} symbols tallied, ${todSkipped} already bootstrapped (re-adding would double-count — these columns are running sums)`);
    if (swingFailed.length) console.log(`  failures: ${swingFailed.slice(0, 10).join('; ')}${swingFailed.length > 10 ? ` (+${swingFailed.length - 10} more)` : ''}`);
  } catch (e) {
    console.error('swing-time backfill failed:', e.message);
  }

  // Binance.US sub-daily crypto backfill: deep 1h OHLCV+volume for the
  // day-trading watchlist specifically (selectIntradayWatchlist's own
  // liquidity-proxied ~25-symbol subset, not the full ~130-asset
  // universe — see its docs, scripts/intraday.mjs, for why that's the
  // right scope for a 30x-leverage use case). This is also the first
  // real PRODUCTION check of Binance.US reachability — local testing
  // confirmed binance.com is geo-blocked (HTTP 451) and binance.us works,
  // but GitHub Actions runners are a different network than local
  // testing; if binanceOk stays at 0 across every symbol here, that's a
  // reachability gate failing, not a per-symbol data problem — check the
  // logged error pattern before trusting Phase 3 (backtest replay) or the
  // correlation-research phases, both of which depend on this table.
  let binanceRowsWritten = 0;
  try {
    const fundingMap = await getFundingMap();
    const watchlist = selectIntradayWatchlist(cryptoUniverse, fundingMap, STOCK_WATCHLIST).filter((w) => w.assetClass === 'crypto');
    const tradablePairs = await binanceUsExchangeInfo();
    const hourlyCoverage = await getExistingHourlyCoverage(env, watchlist.map((w) => w.symbol));
    console.log(`Binance.US: ${tradablePairs.size} tradable USDT pairs found, checking against ${watchlist.length} watchlist symbols`);

    let binanceOk = 0, binanceSkippedNoPair = 0, binanceCaughtUp = 0;
    const binanceFailed = [];
    for (const w of watchlist) {
      if (binanceRowsWritten >= BINANCE_ROW_BUDGET) { console.log('Binance row budget exhausted — stopping early, resume next run'); break; }
      const pairSymbol = `${w.symbol}USDT`;
      if (!tradablePairs.has(pairSymbol)) { binanceSkippedNoPair++; continue; }
      const existing = hourlyCoverage[w.symbol];
      const startMs = existing ? new Date(existing.maxBar).getTime() + 1 : BINANCE_US_FLOOR_MS;
      const nowMs = Date.now();
      if (startMs >= nowMs) { binanceCaughtUp++; continue; }
      // Bound the fetch range to roughly the smaller of the remaining run
      // budget or the per-symbol cap — binanceUsKlines paginates forward
      // with no internal cap by design (so Phase 3's backtest replay can
      // request its own fixed window in one clean call), so an unbounded
      // range here on a symbol's very first run would pull its ENTIRE
      // ~6-year history in one shot, and without the per-symbol cap
      // specifically, that first symbol alone would drain the whole run's
      // budget before any other symbol got a turn (confirmed live).
      const remainingBudget = Math.min(BINANCE_ROW_BUDGET - binanceRowsWritten, BINANCE_PER_SYMBOL_ROW_CAP);
      const boundedEndMs = Math.min(nowMs, startMs + remainingBudget * 3600 * 1000);
      try {
        const bars = await binanceUsKlines(pairSymbol, '1h', startMs, boundedEndMs);
        if (bars.length) {
          const toWrite = bars.map((b) => ({ symbol: w.symbol, assetClass: 'crypto', bar_at: b.ts, close: b.close, high: b.high, low: b.low, volume: b.volume, source: 'binance_us' }));
          const written = await upsertHourlyBars(env, toWrite);
          binanceRowsWritten += written;
          rowsWrittenThisRun += written;
          // Same zero-extra-fetch time-of-day bootstrap as the Yahoo-hourly
          // leg above, just against Binance's deeper, more regime-diverse
          // history (spans the 2020 crash, 2021 top, 2022 bear — Yahoo's
          // 700-day window sits entirely inside one recent stretch).
          const todTallies = computeTimeOfDayTallies(toWrite.map((b) => ({ ts: b.bar_at, close: b.close })));
          if (Object.keys(todTallies).length) await upsertTimeOfDayStats(env, w.symbol, 'crypto', todTallies, new Date().toISOString());
        }
        binanceOk++;
      } catch (e) {
        binanceFailed.push(`${w.symbol} (${e.message})`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`Binance.US hourly backfill: ok ${binanceOk}, no pair ${binanceSkippedNoPair}, already caught up ${binanceCaughtUp}, failed ${binanceFailed.length}, rows written ${binanceRowsWritten}/${BINANCE_ROW_BUDGET}`);
    if (binanceOk === 0 && binanceFailed.length > 0) {
      console.error(`REACHABILITY GATE: every Binance.US attempt failed (${binanceFailed.length}) — check for a geo-block or outage in this environment before trusting this leg, Phase 3, or correlation research`);
    }
    if (binanceFailed.length) console.log(`  failures: ${binanceFailed.slice(0, 10).join('; ')}${binanceFailed.length > 10 ? ` (+${binanceFailed.length - 10} more)` : ''}`);
  } catch (e) {
    console.error('Binance.US backfill failed:', e.message);
  }

  // Reuses `coverage`, updated in place above as each symbol's fresh rows
  // were written, instead of re-querying — was a second full GROUP BY scan
  // of the entire asset_daily_bars table just to log a summary that's
  // already fully derivable from what this run itself wrote.
  const finalCoverage = coverage;
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
