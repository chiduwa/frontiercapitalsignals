// Daily-cadence companion to the hourly build (scripts/build-signals.mjs):
// owns whatever genuinely only needs to run once a day, either because the
// upstream data itself only changes daily (sentiment) or because it needs
// one fetch per symbol and doing that hourly would meaningfully inflate
// the hourly job's runtime/fetch count for no real benefit. Currently:
// per-asset sentiment (CoinGecko community votes, CryptoPanic news
// balance, both optional) and CoinMarketCap's Fear & Greed cross-check
// (optional). Invoked once/day by .github/workflows/signals-daily.yml,
// after backfill-history.mjs in the same job.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: CMC_API_KEY, CRYPTOPANIC_API_TOKEN — both sources simply
//   produce nothing (not an error) when their key is unset, same pattern
//   as TREFIS_OVERRIDES elsewhere in this pipeline.
import { getCryptoMarkets, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME } from '../worker.js';
import {
  coingeckoSentiment, cryptoPanicSentiment, cmcFearGreed,
  upsertAssetSentiment, upsertMarketSentiment
} from './archive.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, CMC_API_KEY, CRYPTOPANIC_API_TOKEN } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

// Per-run row/request budget, not a D1-write concern this time (a few
// thousand sentiment rows/day is trivial) but a politeness-to-upstream one
// — CoinGecko's per-coin detail call is heavier than the bulk /markets
// endpoint already used elsewhere, and CryptoPanic is rate-limited per IP.
const MAX_SYMBOLS = Number(process.env.DAILY_REFRESH_MAX_SYMBOLS || 100);

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`daily-refresh starting for ${today}`);

  const cryptoRaw = await getCryptoMarkets();
  const universe = cryptoRaw
    .filter((c) => !CRYPTO_BLOCKLIST.has((c.symbol || '').toLowerCase()))
    .filter((c) => (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME)
    .map((c) => ({ symbol: (c.symbol || '').toUpperCase(), id: c.id }))
    .slice(0, MAX_SYMBOLS);
  console.log(`universe: ${universe.length} crypto assets`);

  let cgOk = 0, cgFailed = 0, cpOk = 0, cpFailed = 0;
  const rows = [];
  for (const a of universe) {
    let coingeckoUpPct = null, cryptopanicScore = null;
    try {
      coingeckoUpPct = await coingeckoSentiment(a.id);
      if (coingeckoUpPct != null) cgOk++;
    } catch (e) {
      cgFailed++;
      console.error(`coingeckoSentiment failed for ${a.symbol}:`, e.message);
    }
    try {
      cryptopanicScore = await cryptoPanicSentiment(a.symbol, CRYPTOPANIC_API_TOKEN);
      if (cryptopanicScore != null) cpOk++;
    } catch (e) {
      cpFailed++;
      console.error(`cryptoPanicSentiment failed for ${a.symbol}:`, e.message);
    }
    if (coingeckoUpPct != null || cryptopanicScore != null) rows.push({ symbol: a.symbol, coingeckoUpPct, cryptopanicScore });
    // Light pacing against CoinGecko's per-coin-detail endpoint and
    // CryptoPanic's per-IP rate limit — same spirit as the archive
    // backfill's pacing, just a shorter gap since these are much smaller
    // responses than a multi-year history pull.
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`CoinGecko votes: ${cgOk} ok, ${cgFailed} failed${CRYPTOPANIC_API_TOKEN ? '' : ' (CryptoPanic: CRYPTOPANIC_API_TOKEN not set, skipped)'}`);
  if (CRYPTOPANIC_API_TOKEN) console.log(`CryptoPanic: ${cpOk} ok, ${cpFailed} failed`);

  if (rows.length) {
    const written = await upsertAssetSentiment(env, today, rows);
    console.log(`wrote per-asset sentiment for ${rows.length} symbols (${written} rows attempted)`);
  }

  if (CMC_API_KEY) {
    try {
      const cmcValue = await cmcFearGreed(CMC_API_KEY);
      if (cmcValue != null) {
        await upsertMarketSentiment(env, today, { fearGreedCmc: cmcValue });
        console.log(`CMC Fear & Greed: ${cmcValue}`);
      } else {
        console.log('CMC Fear & Greed: unexpected response shape, skipped (see error above)');
      }
    } catch (e) {
      console.error('cmcFearGreed failed:', e.message);
    }
  } else {
    console.log('CMC_API_KEY not set — CoinMarketCap Fear & Greed cross-check skipped');
  }

  console.log('daily-refresh complete');
}

main().catch((e) => { console.error('daily-refresh failed:', e); process.exit(1); });
