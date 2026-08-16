// Thin per-tick entrypoint for the intraday day-trading pipeline (see
// scripts/intraday.mjs for the "why a separate pipeline" background).
// Invoked by .github/workflows/signals-intraday.yml on its own 5-minute
// cron, independent of and much cheaper than build-signals.mjs's full
// engine run: reads the pre-computed watchlist from KV (written by
// build-signals.mjs, which already has the crypto universe/funding data in
// scope — this job never re-derives it), fetches live prices for that
// watchlist only, and writes+prunes intraday_price_ticks.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
//   FCS_KV_NAMESPACE_ID, FCS_D1_DATABASE_ID
import { coingeckoSimplePrice, yahooQuote, pool } from '../worker.js';
import { upsertIntradayTicks, pruneIntradayTicks, loadRecentIntradayTicks, castIntradaySignals, evaluateIntradayMatured } from './intraday.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID, FCS_D1_DATABASE_ID } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

const WATCHLIST_KEY = 'signals:intraday-watchlist';

async function main() {
  const tickAt = new Date().toISOString();

  const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${FCS_KV_NAMESPACE_ID}/values/${encodeURIComponent(WATCHLIST_KEY)}`;
  const kvRes = await fetch(kvUrl, { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } });
  if (!kvRes.ok) {
    // Not yet written (first-ever run before build-signals.mjs has run
    // since this table existed) — not an error, just nothing to tick yet.
    console.log(`watchlist not found in KV (HTTP ${kvRes.status}) — skipping this tick, build-signals.mjs writes it on its next run`);
    return;
  }
  const watchlist = await kvRes.json().catch(() => null);
  if (!Array.isArray(watchlist) || !watchlist.length) {
    console.log('watchlist empty or malformed — skipping this tick');
    return;
  }

  const cryptoEntries = watchlist.filter((w) => w.assetClass === 'crypto');
  const stockEntries = watchlist.filter((w) => w.assetClass === 'stock');
  console.log(`watchlist: ${cryptoEntries.length} crypto, ${stockEntries.length} stock`);

  const rows = [];
  let cryptoOk = 0, stockOk = 0, stockFailed = 0;

  if (cryptoEntries.length) {
    const live = await coingeckoSimplePrice(cryptoEntries.map((c) => c.id));
    for (const c of cryptoEntries) {
      const v = live[c.id];
      if (v && v.price != null) {
        rows.push({ tick_at: tickAt, asset_class: 'crypto', symbol: c.symbol, price: v.price });
        cryptoOk++;
      }
    }
  }

  if (stockEntries.length) {
    const quotes = await pool(stockEntries.map((s) => s.symbol), 8, (symbol) => yahooQuote(symbol));
    for (const q of quotes) {
      if (q && !q._error && q.price != null) {
        rows.push({ tick_at: tickAt, asset_class: 'stock', symbol: q.symbol, price: q.price });
        stockOk++;
      } else {
        stockFailed++;
      }
    }
  }

  const written = await upsertIntradayTicks(env, rows);
  console.log(`tick ${tickAt}: crypto ${cryptoOk}/${cryptoEntries.length} ok, stock ${stockOk}/${stockEntries.length} ok (${stockFailed} failed), ${written} rows written`);

  await pruneIntradayTicks(env);
  console.log('pruned ticks older than the retention window');

  // Cast + evaluate every tick, not on a separate cadence — both are
  // cheap D1-only operations once ticks already exist (no upstream
  // fetches), and running them here means the signal/reliability data is
  // never staler than this tick's own price data.
  try {
    const allSymbols = watchlist.map((w) => w.symbol);
    const ticksBySymbol = await loadRecentIntradayTicks(env, allSymbols);
    const castCount = await castIntradaySignals(env, ticksBySymbol, tickAt);
    console.log(`cast ${castCount} signal rows across ${Object.keys(ticksBySymbol).length} symbols with enough tick history`);
  } catch (e) {
    console.error('signal casting failed (ticks already written):', e.message || e);
  }

  try {
    const evaluatedCount = await evaluateIntradayMatured(env, tickAt);
    console.log(`scored ${evaluatedCount} matured intraday outcomes`);
  } catch (e) {
    console.error('intraday maturity evaluation failed:', e.message || e);
  }
}

main().catch((e) => { console.error('intraday-tick failed:', e); process.exit(1); });
