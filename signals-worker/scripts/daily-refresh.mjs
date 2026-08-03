// Daily-cadence companion to the hourly build (scripts/build-signals.mjs):
// owns whatever genuinely only needs to run once a day, either because the
// upstream data itself only changes daily (sentiment) or because it's
// expensive enough (per-symbol fetches, or an O(n^2)-pairs computation)
// that doing it hourly would add real cost for no real benefit. Currently:
// per-asset sentiment (CoinGecko community votes, CryptoPanic news
// balance, both optional), CoinMarketCap's Fear & Greed cross-check
// (optional), and the cross-asset lead/lag recompute. Invoked once/day by
// .github/workflows/signals-daily.yml, after backfill-history.mjs in the
// same job (lead/lag needs that step's archive data to already be there).
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: CMC_API_KEY, CRYPTOPANIC_API_TOKEN — both sources simply
//   produce nothing (not an error) when their key is unset, same pattern
//   as TREFIS_OVERRIDES elsewhere in this pipeline.
import { getCryptoMarkets, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME } from '../worker.js';
import {
  coingeckoSentiment, cryptoPanicSentiment, cmcFearGreed,
  upsertAssetSentiment, upsertMarketSentiment,
  computeLeadLag, replaceLeadLagSignals
} from './archive.mjs';
import { evaluateYesterdaySwingTimes } from './reliability.mjs';

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
    // 4500ms: even 3000ms (CRYPTO_HISTORY_DELAY_MS's own already-proven-
    // safe value for the *other* per-coin CoinGecko endpoint) still showed
    // real 429s on a live run against this specific one (35/73 succeeded,
    // not a crash — errors are caught and logged per-symbol, never fatal).
    // This endpoint is evidently rate-limited tighter than that one. Not
    // chasing a fully-429-free run further than this: whatever still fails
    // today is retried tomorrow (no "already have data" skip on this
    // path), so partial success now is expected to self-heal over a few
    // days rather than needing a perfectly-tuned delay up front.
    await new Promise((r) => setTimeout(r, 4500));
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

  try {
    const started = Date.now();
    const signals = await computeLeadLag(env);
    const written = await replaceLeadLagSignals(env, signals, new Date().toISOString());
    console.log(`lead/lag: ${written} significant relationships registered (recomputed in ${Date.now() - started}ms)`);
  } catch (e) {
    console.error('lead/lag recompute failed:', e.message);
  }

  try {
    const updated = await evaluateYesterdaySwingTimes(env, new Date().toISOString());
    console.log(`swing-time-of-day: tallied yesterday for ${updated} symbols`);
  } catch (e) {
    console.error('swing-time-of-day forward tally failed:', e.message);
  }

  console.log('daily-refresh complete');
}

main().catch((e) => { console.error('daily-refresh failed:', e); process.exit(1); });
