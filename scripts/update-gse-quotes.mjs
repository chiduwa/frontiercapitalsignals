#!/usr/bin/env node
/**
 * Refresh the cached Ghana Stock Exchange board in Cloudflare KV.
 *
 * WHY THIS IS A LOCAL SCRIPT AND NOT A CRON JOB
 *
 * dev.kwayisi.org, the only source publishing GSE prices as JSON, refuses
 * connections from datacenter IP ranges. Verified 13 September 2026, all
 * timing out at the TCP level while the same request succeeds instantly from a
 * home connection:
 *
 *   Cloudflare Workers  - timed out at 9s and 25s, every colo tried
 *   GitHub Actions      - curl (28) connection timed out, 4 attempts, 60s each
 *   Oracle Cloud host   - no response in 42s
 *
 * So there is no unattended path to this data. Run this from an ordinary
 * internet connection to refresh the board:
 *
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/update-gse-quotes.mjs
 *
 * /api/quotes withholds the board once it is older than four days, so a missed
 * refresh makes Ghana reference-only rather than showing stale prices.
 */

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KV_NAMESPACE_ID = "7c1d54e367ce4e53abd96370cb0203be";
const SOURCE = "https://dev.kwayisi.org/apis/gse/live";
const MIN_ROWS = 20;

const res = await fetch(SOURCE, {
  headers: {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; FrontierCapitalSignals/1.0)",
  },
  signal: AbortSignal.timeout(60_000),
}).catch((err) => {
  throw new Error(
    `Could not reach ${SOURCE}: ${err.message}. This source blocks datacenter ` +
      `IPs — run from an ordinary internet connection, not a server or VPN.`
  );
});

if (!res.ok) throw new Error(`${SOURCE} returned ${res.status}`);

const rows = await res.json();
if (!Array.isArray(rows)) throw new Error("GSE feed did not return an array");

const priced = rows.filter((r) => typeof r?.price === "number" && r.price > 0);
if (priced.length < MIN_ROWS) {
  throw new Error(`GSE feed returned only ${priced.length} priced rows; refusing to publish`);
}

const payload = { fetchedAt: new Date().toISOString(), rows: priced };
const file = join(tmpdir(), "gse-quotes.json");
writeFileSync(file, JSON.stringify(payload));

execFileSync(
  "npx",
  ["wrangler", "kv", "key", "put", "gse:live", "--path", file, "--namespace-id", KV_NAMESPACE_ID, "--remote"],
  { stdio: "inherit" }
);

console.log(`Published ${priced.length} GSE rows at ${payload.fetchedAt}`);
