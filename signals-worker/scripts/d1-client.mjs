// Thin HTTP client for Cloudflare D1's REST API. Extracted from
// reliability.mjs (which was the only caller until the archive/backfill
// scripts needed the exact same thing) so there's one source of truth for
// how every script talks to D1, not a hand-copied duplicate that could
// drift. Requires plain Node (fetch), same as every other script here.

function d1Url(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.FCS_D1_DATABASE_ID}/query`;
}

export async function d1(env, sql, params = []) {
  const res = await fetch(d1Url(env), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success !== true) {
    throw new Error(`D1 query failed: HTTP ${res.status} ${JSON.stringify(body && body.errors)}`);
  }
  return (body.result && body.result[0] && body.result[0].results) || [];
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
