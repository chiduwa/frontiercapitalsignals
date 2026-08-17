// One-time-ish research pass: backtest-seeds intraday_backtest_reliability
// by replaying replayIntradaySignal (worker.js) against ~2 years of real
// Binance.US 15-minute history for the day-trading watchlist. Deliberately
// NOT a daily/resumable job (see .github/workflows/signals-backtest-intraday.yml
// — workflow_dispatch only): each run recomputes the FULL current 2-year
// window fresh and replaces the aggregate row per (symbol, horizon)
// (INSERT OR REPLACE), so there's nothing to resume or budget across runs
// the way the incremental price/hourly-bar backfills need — a fixed,
// bounded 2-year klines fetch per symbol, one pass, done.
//
// Kept deliberately separate from the LIVE intraday_reliability table:
// backtested accuracy on dense, regular Binance candles isn't automatically
// comparable to live accuracy on genuinely irregular real-world ticks
// without its own scrutiny first (not wired into buildIntradayDisplayPayload's
// adaptive-horizon selection this round).
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
import { getCryptoMarkets, getFundingMap, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME, STOCK_WATCHLIST, replayIntradaySignal } from '../worker.js';
import { binanceUsExchangeInfo, binanceUsKlines } from './archive.mjs';
import { selectIntradayWatchlist, INTRADAY_HORIZONS_MIN } from './intraday.mjs';
import { d1, chunk } from './d1-client.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

// 730 days x 96 (15-min bars/day) = 70,080 bars/symbol -> ~71 requests/symbol
// (Binance's 1000-candle-per-request cap) x 25 watchlist symbols ~= 1775
// requests total, ~9 minutes at the 300ms pacing below. Single pass, no
// resumability needed — see the top-of-file comment for why.
const BACKTEST_WINDOW_DAYS = 730;
const MIN_BARS_TO_SCORE = 100; // a recently-listed symbol with too little real Binance.US history to say anything meaningful

async function main() {
  const now = Date.now();
  const windowStartMs = now - BACKTEST_WINDOW_DAYS * 24 * 3600 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const nowIso = new Date(now).toISOString();
  console.log(`backtest-intraday starting: replaying ${BACKTEST_WINDOW_DAYS} days (${windowStartIso} to ${nowIso})`);

  const cryptoRaw = await getCryptoMarkets();
  const cryptoUniverse = cryptoRaw
    .filter((c) => !CRYPTO_BLOCKLIST.has((c.symbol || '').toLowerCase()))
    .filter((c) => (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME)
    .map((c) => ({ symbol: (c.symbol || '').toUpperCase(), id: c.id }));
  const fundingMap = await getFundingMap();
  const watchlist = selectIntradayWatchlist(cryptoUniverse, fundingMap, STOCK_WATCHLIST).filter((w) => w.assetClass === 'crypto');
  const tradablePairs = await binanceUsExchangeInfo();
  console.log(`watchlist: ${watchlist.length} crypto symbols, ${tradablePairs.size} tradable Binance.US pairs`);

  let ok = 0, skippedNoPair = 0, thin = 0;
  const failed = [];
  for (const w of watchlist) {
    const pairSymbol = `${w.symbol}USDT`;
    if (!tradablePairs.has(pairSymbol)) { skippedNoPair++; continue; }
    try {
      const bars = await binanceUsKlines(pairSymbol, '15m', windowStartMs, now);
      if (bars.length < MIN_BARS_TO_SCORE) { thin++; continue; }
      const ticks = bars.map((b) => ({ tick_at: b.ts, price: b.close }));
      const results = replayIntradaySignal(ticks, 'crypto', INTRADAY_HORIZONS_MIN);
      const rows = Object.entries(results)
        .filter(([, r]) => r.total > 0)
        .map(([h, r]) => ({ horizonMinutes: Number(h), correct: r.correct, total: r.total, accuracy: r.correct / r.total }));
      if (rows.length) {
        // 9 cols x 11 rows = 99 params, under D1's confirmed 100-bound-
        // param ceiling. INSERT OR REPLACE, not an incremental upsert —
        // each run's accuracy is a fresh computation over the current
        // window, not something to accumulate across runs.
        for (const batch of chunk(rows, 11)) {
          const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
          const params = batch.flatMap((r) => ['crypto', w.symbol, r.horizonMinutes, r.correct, r.total, r.accuracy, windowStartIso, nowIso, nowIso]);
          await d1(env, `INSERT OR REPLACE INTO intraday_backtest_reliability (asset_class, symbol, horizon_minutes, correct, total, accuracy, window_start, window_end, updated_at) VALUES ${placeholders}`, params);
        }
        const summary = Object.fromEntries(rows.map((r) => [r.horizonMinutes, `${r.correct}/${r.total} (${(r.accuracy * 100).toFixed(1)}%)`]));
        console.log(`${w.symbol}: ${bars.length} bars replayed — ${JSON.stringify(summary)}`);
      } else {
        console.log(`${w.symbol}: ${bars.length} bars replayed, no scoreable calls at any horizon`);
      }
      ok++;
    } catch (e) {
      failed.push(`${w.symbol} (${e.message})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`backtest-intraday: ok ${ok}, no pair ${skippedNoPair}, thin history ${thin}, failed ${failed.length}`);
  if (failed.length) console.log(`  failures: ${failed.slice(0, 10).join('; ')}${failed.length > 10 ? ` (+${failed.length - 10} more)` : ''}`);
}

main().catch((e) => { console.error('backtest-intraday failed:', e); process.exit(1); });
