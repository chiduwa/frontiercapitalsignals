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
import { loadReliability, logRun, evaluateMatured } from './reliability.mjs';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID, FCS_D1_DATABASE_ID, TREFIS_OVERRIDES } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}

const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };

// The reliability loop is additive, not load-bearing: if D1 isn't
// configured yet, or a D1 call fails, the core dashboard build must still
// succeed with today's baseline (unweighted) scoring rather than blocking
// the hourly KV refresh on a secondary subsystem.
let reliability;
if (FCS_D1_DATABASE_ID) {
  try {
    reliability = await loadReliability(env);
    console.log(`loaded reliability stats for ${Object.keys(reliability).length} (symbol, technique) pairs`);
  } catch (e) {
    console.error('loadReliability failed, continuing with baseline weights:', e.message || e);
  }
} else {
  console.log('FCS_D1_DATABASE_ID not set — reliability weighting disabled, using baseline weights');
}

const started = Date.now();
const { payload, log } = await buildPayload({ TREFIS_OVERRIDES }, reliability);
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
    console.log(`logged ${log.votes.length} votes + ${log.prices.length} prices; scored ${evaluatedCount} matured outcomes`);
  } catch (e) {
    console.error('reliability logging/evaluation failed (KV already updated, dashboard unaffected):', e.message || e);
  }
}
