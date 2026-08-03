// Daily-cadence companion to the hourly build (scripts/build-signals.mjs):
// owns whatever genuinely only needs to run once a day, either because the
// upstream data itself only changes daily (sentiment) or because it's
// expensive enough (per-symbol fetches, or an O(n^2)-pairs computation)
// that doing it hourly would add real cost for no real benefit. Currently:
// per-asset sentiment (CoinGecko community votes, CryptoPanic news
// balance, both optional), CoinMarketCap's Fear & Greed cross-check
// (optional), the sector-taxonomy + composite recompute, and the
// cross-asset lead/lag recompute. Invoked once/day by
// .github/workflows/signals-daily.yml, after backfill-history.mjs in the
// same job (lead/lag needs that step's archive data to already be there).
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: CMC_API_KEY, CRYPTOPANIC_API_TOKEN — both sources simply
//   produce nothing (not an error) when their key is unset, same pattern
//   as TREFIS_OVERRIDES elsewhere in this pipeline.
import { getCryptoMarkets, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME, mapCategoriesToSectors } from '../worker.js';
import {
  coingeckoSentiment, cryptoPanicSentiment, cmcFearGreed,
  upsertAssetSentiment, upsertMarketSentiment,
  computeLeadLag, replaceLeadLagSignals,
  fetchDefiLlamaHacks, matchHacksToUniverse, upsertAssetEvents,
  replaceAssetSectors, computeSectorComposites, upsertDailyBars
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
  const fullUniverse = cryptoRaw
    .filter((c) => !CRYPTO_BLOCKLIST.has((c.symbol || '').toLowerCase()))
    .filter((c) => (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME)
    .map((c) => ({ symbol: (c.symbol || '').toUpperCase(), id: c.id, name: c.name || '' }));
  // Sentiment specifically stays capped at MAX_SYMBOLS (per-coin fetches
  // are the expensive part there); hack-matching below uses the full
  // universe since a hack can hit any tracked asset, not just the first N.
  const universe = fullUniverse.slice(0, MAX_SYMBOLS);
  console.log(`universe: ${fullUniverse.length} crypto assets (${universe.length} in the sentiment pass)`);

  let cgOk = 0, cgFailed = 0, cpOk = 0, cpFailed = 0;
  const rows = [];
  const sectorRows = [];
  for (const a of universe) {
    let coingeckoUpPct = null, cryptopanicScore = null;
    try {
      const cg = await coingeckoSentiment(a.id);
      coingeckoUpPct = cg.up;
      if (coingeckoUpPct != null) cgOk++;
      for (const sector of mapCategoriesToSectors(cg.categories)) sectorRows.push({ symbol: a.symbol, sector });
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
    const sectorsWritten = await replaceAssetSectors(env, sectorRows);
    const distinctSectors = new Set(sectorRows.map((r) => r.sector));
    console.log(`sector taxonomy: ${distinctSectors.size} sectors, ${sectorsWritten} (symbol, sector) memberships`);
    const composites = await computeSectorComposites(env, sectorRows);
    if (composites.length) {
      const written = await upsertDailyBars(env, composites);
      console.log(`sector composites: ${new Set(composites.map((c) => c.symbol)).size} sector series, ${written} rows attempted (full history recomputed each run; INSERT OR IGNORE means only genuinely new dates land)`);
    } else {
      console.log('sector composites: no sector cleared the minimum-constituent bar yet');
    }
  } catch (e) {
    console.error('sector taxonomy/composite computation failed:', e.message);
  }

  // Runs AFTER the sector-composite step above so this same pass's
  // SECTOR:<name> rows are already in asset_daily_bars — computeLeadLag
  // treats them as just more symbols, so sector-vs-sector and
  // sector-vs-asset relationships are discovered in this same O(n^2) call,
  // no separate sector-lead-lag engine needed.
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

  try {
    const hacks = await fetchDefiLlamaHacks();
    const matched = matchHacksToUniverse(hacks, fullUniverse);
    const written = await upsertAssetEvents(env, matched);
    const linked = matched.filter((h) => h.symbol).length;
    console.log(`hack/exploit events: ${hacks.length} fetched, ${linked} matched to a tracked symbol, ${written} rows attempted (INSERT OR IGNORE, so re-runs are cheap)`);
  } catch (e) {
    console.error('DeFiLlama hacks fetch failed:', e.message);
  }

  console.log('daily-refresh complete');
}

main().catch((e) => { console.error('daily-refresh failed:', e); process.exit(1); });
