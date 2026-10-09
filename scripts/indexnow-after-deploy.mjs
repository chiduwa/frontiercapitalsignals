#!/usr/bin/env node
// Submit freshly published URLs to IndexNow (Bing, Yandex, Seznam, Naver) after
// the deploy. The generator used to submit before deploy.yml had even run, so
// engines were sent URLs that still returned 404.
//
// Selects briefs dated today or yesterday (UTC) from content/intelligence plus
// the pages that list them, confirms each canonical URL returns 200 and that
// the key file is served, then submits only what passed. `--dry-run` prints
// the list without submitting.

import fs from "node:fs";
import path from "node:path";

const SITE = "https://frontiercapitalsignals.com";
const KEY = "fcs3902425740540825";
const KEY_URL = `${SITE}/${KEY}.txt`;
const CONTENT_DIR = path.join(process.cwd(), "content", "intelligence");

const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const recent = new Set([day(0), day(1)]);
const slugs = fs.readdirSync(CONTENT_DIR)
  .filter((f) => f.endsWith(".md") && recent.has(f.slice(0, 10)))
  .map((f) => f.replace(/\.md$/, ""));

if (slugs.length === 0) {
  console.log("No briefs dated today or yesterday; nothing to submit.");
  process.exit(0);
}

const candidates = [`${SITE}/`, `${SITE}/intelligence`, ...slugs.map((s) => `${SITE}/intelligence/${s}`)];

async function get(url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "fcs-indexnow-check" } });
    return { code: res.status, body: res.status === 200 ? await res.text() : "" };
  } catch (e) {
    return { code: 0, body: "", error: e.message };
  }
}

async function liveWithRetry(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    if ((await get(url)).code === 200) return true;
    await new Promise((ok) => setTimeout(ok, 10000));
  }
  return false;
}

const key = await get(KEY_URL);
if (key.code !== 200 || key.body.trim() !== KEY) {
  console.error(`::error::IndexNow key file ${KEY_URL} returned ${key.code}; not submitting.`);
  process.exit(1);
}

const live = [];
for (const url of candidates) {
  if (await liveWithRetry(url)) live.push(url);
  else console.warn(`::warning::${url} is not returning 200 after the deploy; not submitted.`);
}
if (live.length === 0) {
  console.error("::error::None of the new URLs is live; nothing submitted.");
  process.exit(1);
}

if (process.argv.includes("--dry-run")) {
  console.log(`Dry run: would submit ${live.length} URL(s):\n  ${live.join("\n  ")}`);
  process.exit(0);
}

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: "frontiercapitalsignals.com", key: KEY, keyLocation: KEY_URL, urlList: live }),
  signal: AbortSignal.timeout(20000),
});
// 200 = accepted, 202 = accepted while the key is validated. Anything else is a failure.
console.log(`IndexNow: HTTP ${res.status} for ${live.length} URL(s):\n  ${live.join("\n  ")}`);
if (res.status !== 200 && res.status !== 202) {
  console.error(`::error::IndexNow rejected the submission: ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
