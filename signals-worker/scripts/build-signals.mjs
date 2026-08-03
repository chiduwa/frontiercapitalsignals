// Runs the Frontier Capital Signals engine (the same buildPayload() the
// Worker used to run inline) in a normal Node process — no 10ms-CPU or
// 50-subrequest ceiling here, unlike Workers Free plan — then writes the
// result straight into the Worker's KV namespace over the Cloudflare API.
// Also drives the reliability-learning loop (scripts/reliability.mjs):
// loads each technique's measured per-asset accuracy from D1, feeds it into
// this run's scoring as a weight adjustment, then logs this run's votes and
// scores whichever past forecasts have now matured.
// Invoked hourly by .github/workflows/signals-refresh.yml.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID
// Optional env: TREFIS_OVERRIDES
// Optional (enables reliability weighting when set): FCS_D1_DATABASE_ID
import { buildPayload, CACHE_KEY } from '../worker.js';
import { loadReliability, loadMoveStats, loadRangeReliability, loadTimeOfDayStats, loadFundingHistory, loadSentimentMap, loadLeadLagSignals, loadSwingTimeStats, logRun, evaluateMatured, evaluateTimeOfDay, snapshotAssetScores } from './reliability.mjs';
import { upsertMarketSentiment, loadRecentBars } from './archive.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID, FCS_D1_DATABASE_ID, TREFIS_OVERRIDES } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}

const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

// The reliability loop is additive, not load-bearing: if D1 isn't
// configured yet, or a D1 call fails, the core dashboard build must still
// succeed with today's baseline (unweighted, methodology-only-horizon,
// volatility-only-range) scoring rather than blocking the hourly KV
// refresh on a secondary subsystem.
let reliability, reliabilityByHorizon, moveStats, rangeReliability, todStats, fundingHistory, sentimentMap, leadLagSignals, leaderReturns, swingTimeStats;
if (FCS_D1_DATABASE_ID) {
  try {
    const rel = await loadReliability(env);
    reliability = rel.blended;
    reliabilityByHorizon = rel.byHorizon;
    console.log(`loaded reliability stats for ${Object.keys(reliability).length} (symbol, technique) pairs`);
    moveStats = await loadMoveStats(env);
    console.log(`loaded realized-move stats for ${Object.keys(moveStats).length} (symbol, horizon) pairs`);
    rangeReliability = await loadRangeReliability(env);
    console.log(`loaded range-prediction stats for ${Object.keys(rangeReliability).length} symbols`);
    todStats = await loadTimeOfDayStats(env);
    console.log(`loaded time-of-day stats for ${Object.keys(todStats).length} (symbol, slot, horizon) triples`);
    fundingHistory = await loadFundingHistory(env);
    console.log(`loaded funding/OI percentile history for ${Object.keys(fundingHistory).length} symbols`);
    sentimentMap = await loadSentimentMap(env);
    console.log(`loaded per-asset sentiment for ${Object.keys(sentimentMap).length} symbols`);
    leadLagSignals = await loadLeadLagSignals(env);
    const leaderSymbols = [...new Set(Object.values(leadLagSignals).flat().map((r) => r.leaderSymbol))];
    console.log(`loaded lead/lag signals for ${Object.keys(leadLagSignals).length} followers, ${leaderSymbols.length} distinct leaders`);
    // Only the specific leader symbols actually registered — not the whole
    // archive — kept small and cheap regardless of how deep the archive
    // itself grows.
    leaderReturns = await loadRecentBars(env, leaderSymbols, 15);
    swingTimeStats = await loadSwingTimeStats(env);
    console.log(`loaded swing-time-of-day stats for ${Object.keys(swingTimeStats).length} (symbol, slot, extreme) triples`);
  } catch (e) {
    console.error('loadReliability/loadMoveStats/loadRangeReliability/loadTimeOfDayStats/loadFundingHistory/loadSentimentMap/loadLeadLagSignals/loadSwingTimeStats failed, continuing with baseline weights:', e.message || e);
  }
} else {
  console.log('FCS_D1_DATABASE_ID not set — reliability weighting disabled, using baseline weights');
}

const started = Date.now();
const { payload, log } = await buildPayload({ TREFIS_OVERRIDES }, reliability, reliabilityByHorizon, moveStats, rangeReliability, todStats, fundingHistory, sentimentMap, leadLagSignals, leaderReturns, swingTimeStats);
console.log(`built payload in ${Date.now() - started}ms — crypto ${payload.crypto.universe} assets, stocks ${payload.stocks.universe} assets`);
console.log('health:', JSON.stringify(payload.health));

const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${FCS_KV_NAMESPACE_ID}/values/${encodeURIComponent(CACHE_KEY)}`;
const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
const resBody = await res.json().catch(() => null);
if (!res.ok || !resBody || resBody.success !== true) {
  console.error(`KV write failed: HTTP ${res.status}`, JSON.stringify(resBody));
  process.exit(1);
}
console.log(`wrote ${CACHE_KEY} to KV namespace ${FCS_KV_NAMESPACE_ID}`);

if (FCS_D1_DATABASE_ID) {
  try {
    await logRun(env, payload.generated_at, log);
    const evaluatedCount = await evaluateMatured(env, payload.generated_at);
    console.log(`logged ${log.votes.length} votes + ${log.prices.length} prices + ${log.ranges.length} range predictions; scored ${evaluatedCount} matured outcomes`);
  } catch (e) {
    console.error('reliability logging/evaluation failed (KV already updated, dashboard unaffected):', e.message || e);
  }
  try {
    // Reuses this run's own just-logged prices (no re-query) — see
    // evaluateTimeOfDay's docs for why this needs nothing to mature.
    const priceMap = Object.fromEntries(log.prices.map((p) => [p.symbol, { price: p.price, assetClass: p.asset_class }]));
    const todUpdates = await evaluateTimeOfDay(env, payload.generated_at, priceMap);
    console.log(`updated time-of-day stats for ${todUpdates} (symbol, slot) pairs`);
  } catch (e) {
    console.error('time-of-day evaluation failed (KV already updated, dashboard unaffected):', e.message || e);
  }
  try {
    // Reuses Fear & Greed / VIX already fetched for this run's own
    // payload.overview — no new call. Per-asset sentiment (CoinGecko
    // votes, CryptoPanic) is a daily-cadence job (scripts/daily-refresh.mjs)
    // since it needs one fetch per symbol; this is just today's market-
    // wide reading, cheap enough to log every hour it changes.
    const today = payload.generated_at.slice(0, 10);
    await upsertMarketSentiment(env, today, {
      fearGreedAltme: payload.overview.fear_greed ? payload.overview.fear_greed.value : null,
      vixRangePos: payload.overview.vix ? payload.overview.vix.rangePos : null
    });
  } catch (e) {
    console.error('market-wide sentiment logging failed (KV already updated, dashboard unaffected):', e.message || e);
  }
  try {
    // Reuses this run's own already-loaded reliability/rangeReliability
    // (no re-query) — upserts, so "today" reflects this run's numbers
    // every hour until the date rolls over, then freezes as history.
    const today = payload.generated_at.slice(0, 10);
    const snapshotted = await snapshotAssetScores(env, today, reliability, rangeReliability);
    console.log(`snapshotted prediction scores for ${snapshotted} assets`);
  } catch (e) {
    console.error('score snapshotting failed (KV already updated, dashboard unaffected):', e.message || e);
  }
}
