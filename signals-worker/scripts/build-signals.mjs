// Runs the Frontier Capital Signals engine (the same buildPayload() the
// Worker used to run inline) in a normal Node process — no 10ms-CPU or
// 50-subrequest ceiling here, unlike Workers Free plan — then writes the
// result straight into the Worker's KV namespace over the Cloudflare API.
// Invoked hourly by .github/workflows/signals-refresh.yml.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID
// Optional env: TREFIS_OVERRIDES
import { buildPayload, CACHE_KEY } from '../worker.js';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID, TREFIS_OVERRIDES } = process.env;
for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_KV_NAMESPACE_ID })) {
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}

const started = Date.now();
const payload = await buildPayload({ TREFIS_OVERRIDES });
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
