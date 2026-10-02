import { exportState, recoverOutcomes } from '../../../scripts/big-move-watch-io.mjs';
// Read-only. Any D1-read credential: the workflows' CLOUDFLARE_API_TOKEN, or wrangler's OAuth token from `wrangler login`.
const env = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || process.env.CF_OAUTH, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID };
const st = await exportState(env);
const rec = await recoverOutcomes(env, st.open);
console.log(`open ${st.open.length}; recovered ${rec.length}:`, rec.map(r => `${r.symbol} ${r.as_of} ${r.source} ${(r.fwd2 * 100).toFixed(1)}%${Math.abs(r.fwd2) >= 0.12 ? ' BIG' : ''}`).join(' | '));
