// Daily-cadence companion to the hourly build (scripts/build-signals.mjs):
// owns whatever genuinely only needs to run once a day, either because the
// upstream data itself only changes daily (sentiment) or because it's
// expensive enough (per-symbol fetches, or an O(n^2)-pairs computation)
// that doing it hourly would add real cost for no real benefit. Currently:
// per-asset sentiment (CoinGecko community votes, CryptoPanic news
// balance, both optional), CoinMarketCap's Fear & Greed cross-check
// (optional), the sector-taxonomy + composite recompute, the 2s10s
// Treasury yield spread recompute, the DeFiLlama TVL fetch, the Deribit
// DVOL (implied vol) fetch, the stock ATM IV fetch (Yahoo options chain),
// and the cross-asset lead/lag recompute.
// Invoked once/day by .github/workflows/signals-daily.yml, after
// backfill-history.mjs in the same job (lead/lag needs that step's
// archive data to already be there).
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: CMC_API_KEY, CRYPTOPANIC_API_TOKEN, NTFY_TOPIC — all three
//   simply produce/send nothing (not an error) when unset, same pattern
//   as TREFIS_OVERRIDES elsewhere in this pipeline.
import { getCryptoMarkets, getGlobal, CRYPTO_BLOCKLIST, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME, mapCategoriesToSectors, STOCK_WATCHLIST, getCrumb } from '../worker.js';
import {
  coingeckoSentiment, cryptoPanicSentiment, cmcFearGreed,
  upsertAssetSentiment, upsertMarketSentiment,
  computeLeadLag, replaceLeadLagSignals,
  fetchDefiLlamaHacks, matchHacksToUniverse, upsertAssetEvents,
  replaceAssetSectors, computeSectorComposites, upsertDailyBars,
  computeYieldSpread,
  fetchDefiLlamaProtocols, matchProtocolsToUniverse, defiLlamaProtocolTvlHistory,
  fetchDeribitDvolHistory, upsertIvDaily, fetchStockAtmIv,
  computeSrLevelsAndBreaks, replaceSrLevels, replaceSrBreakStats,
  computeMarketComposite, upsertMarketCapTotal,
  computeOutperformanceRotations, replaceRotationStatus,
  computeLongTermBottomCandidates, replaceLongTermBottomCandidates
} from './archive.mjs';
import { d1 } from './d1-client.mjs';
import { evaluateYesterdaySwingTimes } from './reliability.mjs';
import { notifyOnNewHacks } from './notify.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, CMC_API_KEY, CRYPTOPANIC_API_TOKEN, NTFY_TOPIC } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC };

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
    let coingeckoUpPct = null, cryptopanicScore = null, quality = null;
    try {
      const cg = await coingeckoSentiment(a.id);
      coingeckoUpPct = cg.up;
      quality = cg;
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
    if (coingeckoUpPct != null || cryptopanicScore != null || quality) {
      rows.push({
        symbol: a.symbol, coingeckoUpPct, cryptopanicScore,
        githubCommits4w: quality ? quality.githubCommits4w : null,
        githubPrContributors: quality ? quality.githubPrContributors : null,
        communityReach: quality ? quality.communityReach : null,
        watchlistUsers: quality ? quality.watchlistUsers : null
      });
    }
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
      console.log(`sector composites: ${new Set(composites.map((c) => c.symbol)).size} sector series, ${written} rows attempted (full history on a sector's first run, a 1-2-row append after that)`);
    } else {
      console.log('sector composites: no sector cleared the minimum-constituent bar yet');
    }
  } catch (e) {
    console.error('sector taxonomy/composite computation failed:', e.message);
  }

  // MCAP:BROAD (retrospective proxy, deep history via the existing sector-
  // composite machinery) and MCAP:TOTAL (the real dollar figure, short
  // history by construction) — see their own docs in archive.mjs for why
  // both exist rather than just one.
  try {
    const marketComposite = await computeMarketComposite(env);
    if (marketComposite.length) {
      const written = await upsertDailyBars(env, marketComposite);
      console.log(`broad market composite (MCAP:BROAD): ${written} rows attempted (full history on the first run, a 1-2-row append after that)`);
    } else {
      console.log('broad market composite: not enough constituent history yet');
    }
  } catch (e) {
    console.error('broad market composite computation failed:', e.message);
  }

  // Depends on MCAP:BROAD already being written (the step just above) —
  // needs it as the benchmark to compare every crypto asset against.
  try {
    const rotations = await computeOutperformanceRotations(env);
    const written = await replaceRotationStatus(env, rotations);
    console.log(`outperformer rotation: ${written} symbol(s) currently in a sustained multi-month outperformance streak${rotations.length ? ' -- ' + rotations.map((r) => `${r.symbol} (+${r.peakRel.toFixed(0)}pts)`).join(', ') : ''}`);
  } catch (e) {
    console.error('outperformer rotation computation failed:', e.message);
  }

  try {
    const candidates = await computeLongTermBottomCandidates(env);
    const written = await replaceLongTermBottomCandidates(env, candidates);
    console.log(`long-term potential: ${written} symbol(s) currently near a fresh multi-month/year low${candidates.length ? ' -- ' + candidates.map((c) => `${c.symbol} (${c.daysSinceLow}d since low)`).join(', ') : ''}`);
  } catch (e) {
    console.error('long-term potential computation failed:', e.message);
  }

  try {
    const global = await getGlobal();
    if (global && global.total_mcap != null) {
      const written = await upsertMarketCapTotal(env, today, global.total_mcap);
      console.log(`real total market cap (MCAP:TOTAL): $${(global.total_mcap / 1e9).toFixed(1)}B, ${written} row attempted`);
    } else {
      console.log('real total market cap: getGlobal() returned nothing usable this run');
    }
  } catch (e) {
    console.error('real total market cap fetch failed:', e.message);
  }

  try {
    const spread = await computeYieldSpread(env, 'UST10Y', 'UST2Y', 'SPREAD:2s10s');
    if (spread.length) {
      const written = await upsertDailyBars(env, spread);
      console.log(`2s10s yield spread: ${written} rows attempted (cheap full recompute each run, INSERT OR IGNORE so only new dates land)`);
    } else {
      console.log('2s10s yield spread: not enough overlapping UST2Y/UST10Y history yet');
    }
  } catch (e) {
    console.error('2s10s yield spread computation failed:', e.message);
  }

  try {
    const protocols = await fetchDefiLlamaProtocols();
    const matched = matchProtocolsToUniverse(protocols, fullUniverse);
    console.log(`TVL: ${protocols.length} DeFiLlama protocols fetched, ${matched.length} matched to a tracked symbol by gecko_id`);
    let tvlOk = 0, tvlFailed = 0;
    const tvlRows = [];
    for (const p of matched) {
      try {
        const history = await defiLlamaProtocolTvlHistory(p.slug);
        for (const point of history) tvlRows.push({ symbol: `TVL:${p.symbol}`, assetClass: 'tvl', date: point.date, close: point.close, high: null, low: null, volume: null, source: 'defillama' });
        tvlOk++;
      } catch (e) {
        tvlFailed++;
        console.error(`defiLlamaProtocolTvlHistory failed for ${p.symbol} (${p.slug}):`, e.message);
      }
      // 500ms: no rate-limit issues observed against this host so far this
      // session (unlike Yahoo's crumb endpoint or CoinGecko's per-coin
      // detail call), but matched is typically small (a fraction of the
      // universe — TVL is a DeFi-specific concept, not every asset has a
      // protocol) so a moderate pace here is cheap insurance, not a real
      // time cost.
      await new Promise((r) => setTimeout(r, 500));
    }
    if (tvlRows.length) {
      const written = await upsertDailyBars(env, tvlRows);
      console.log(`TVL history: ${tvlOk} protocols ok, ${tvlFailed} failed, ${written} rows attempted (full history on a symbol's first run, INSERT OR IGNORE means only new dates land after that)`);
    }
  } catch (e) {
    console.error('TVL fetch/match failed:', e.message);
  }

  // Shared read for lead/lag AND support/resistance below: both run back-
  // to-back here, both after sector-composite/MCAP/yield-spread/TVL are
  // already written (so SECTOR:<name>/MCAP:BROAD/SPREAD:2s10s/TVL:<symbol>
  // rows are all in asset_daily_bars by now — computeLeadLag treats them
  // as just more symbols, so those relationships are discovered in its
  // same O(n^2) pass, no separate lead-lag engine needed for any of them),
  // and both were independently pulling the ENTIRE table — confirmed live,
  // ~660-700K rows_read each. One read instead of two, same data either
  // function would have fetched on its own (see their own docs,
  // computeLeadLag/computeSrLevelsAndBreaks in archive.mjs, for why this
  // is safe: each already accepts a preloadedRows override with identical
  // behavior to fetching it itself).
  let sharedDailyBarsRows = null;
  try {
    sharedDailyBarsRows = await d1(env, 'SELECT symbol, asset_class, date, close, high, low FROM asset_daily_bars ORDER BY symbol, date');
    console.log(`shared archive read for lead/lag + support/resistance: ${sharedDailyBarsRows.length} rows`);
  } catch (e) {
    console.error('shared archive read failed — lead/lag and support/resistance will each fall back to their own read:', e.message);
  }

  try {
    const started = Date.now();
    const signals = await computeLeadLag(env, sharedDailyBarsRows);
    const written = await replaceLeadLagSignals(env, signals, new Date().toISOString());
    console.log(`lead/lag: ${written} significant relationships registered (recomputed in ${Date.now() - started}ms)`);
  } catch (e) {
    console.error('lead/lag recompute failed:', e.message);
  }

  // Independent of everything else in this file besides the shared read
  // above — writes its own two tables, so a failure here can't take down
  // sentiment/sectors/lead-lag or vice versa.
  try {
    const started = Date.now();
    const { levelsBySymbol, breaks } = await computeSrLevelsAndBreaks(env, sharedDailyBarsRows);
    const levelsWritten = await replaceSrLevels(env, levelsBySymbol);
    const statsWritten = await replaceSrBreakStats(env, breaks);
    console.log(`support/resistance: ${Object.keys(levelsBySymbol).length} symbols with a key level, ${levelsWritten} levels, ${breaks.length} historical break events -> ${statsWritten} calibration buckets (${Date.now() - started}ms)`);
  } catch (e) {
    console.error('support/resistance computation failed:', e.message);
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
    const alerted = await notifyOnNewHacks(env, matched, new Date().toISOString());
    console.log(`hack alerts: ${alerted} sent${env.NTFY_TOPIC ? '' : ' (NTFY_TOPIC not set, skipped)'}`);
  } catch (e) {
    console.error('DeFiLlama hacks fetch failed:', e.message);
  }

  // BTC/ETH only — the only two currencies Deribit publishes DVOL for.
  // One call each; a symbol's first write bootstraps its full available
  // history (~2.75 years), every run after that adds only the latest day.
  for (const currency of ['BTC', 'ETH']) {
    try {
      const history = await fetchDeribitDvolHistory(currency);
      const written = await upsertIvDaily(env, currency, history);
      console.log(`Deribit DVOL (${currency}): ${history.length} daily points fetched, ${written} rows attempted`);
    } catch (e) {
      console.error(`Deribit DVOL fetch failed for ${currency}:`, e.message);
    }
  }

  // Front-month ATM-ish IV for the stock half of the impliedvol technique
  // (Phase 3c built the crypto half via Deribit DVOL above; this extends
  // the same technique/table to equities rather than creating a parallel
  // one). One crumb handshake shared across the whole loop — same 6h
  // in-memory cache getValuation's own calls already rely on, just reused
  // here via the freshly exported getCrumb. Paced like the TVL loop above:
  // no observed rate-limiting against this host in production (unlike this
  // same host's crumb endpoint against a residential/testing IP earlier
  // this session), but 61 stocks is cheap enough that a moderate pace
  // costs nothing real.
  try {
    const auth = await getCrumb();
    let ivOk = 0, ivFailed = 0;
    for (const symbol of STOCK_WATCHLIST) {
      try {
        const iv = await fetchStockAtmIv(symbol, auth);
        if (iv != null) {
          await upsertIvDaily(env, symbol, [{ date: today, dvol: iv }], 'yahoo');
          ivOk++;
        }
      } catch (e) {
        ivFailed++;
        console.error(`fetchStockAtmIv failed for ${symbol}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    console.log(`stock ATM IV: ${ivOk} ok, ${ivFailed} failed (of ${STOCK_WATCHLIST.length})`);
  } catch (e) {
    console.error('stock ATM IV pass failed (crumb handshake):', e.message);
  }

  console.log('daily-refresh complete');
}

main().catch((e) => { console.error('daily-refresh failed:', e); process.exit(1); });
