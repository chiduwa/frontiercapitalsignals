/**
 * Daily intelligence generation script.
 * Fetches Africa investment news from RSS, rewrites with Gemini, saves as Markdown.
 * After generation: submits new URLs to IndexNow + pings Google/Bing sitemaps.
 * Run: node scripts/generate-intelligence.mjs
 * Requires: GOOGLE_AI_API_KEY in environment.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import RSSParser from "rss-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(__dirname, "../content/intelligence");

if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });

if (!process.env.GOOGLE_AI_API_KEY) {
  console.error("Error: GOOGLE_AI_API_KEY is not set. Exiting.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

// gemini-2.5-flash has its own free-tier quota bucket separate from gemini-2.0-flash
const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.0-flash-lite";

const parser = new RSSParser({ timeout: 10000 });

const SITE = "https://frontiercapitalsignals.com";
const INDEXNOW_KEY = "fcs3902425740540825";

// Minimum posts to generate before calling the run successful
const MIN_NEW_POSTS = 3;
// Skip generation if today already has this many posts (prevents quota waste on re-runs)
const SKIP_IF_TODAY_HAS = 5;

const SOURCES = [
  { url: "https://www.theafricareport.com/feed/", country: "Africa" },
  { url: "https://businessday.ng/feed/", country: "Nigeria" },
  { url: "https://www.premiumtimesng.com/feed", country: "Nigeria" },
  { url: "https://citibusinessnews.com/feed/", country: "Ghana" },
  { url: "https://thebftonline.com/feed/", country: "Ghana" },
  { url: "https://www.nyasatimes.com/feed/", country: "Malawi" },
  { url: "https://malawi24.com/feed/", country: "Malawi" },
  { url: "https://www.itnewsafrica.com/feed/", country: "Africa" },
  { url: "https://africabriefing.com/feed/", country: "Africa" },
];

const INVESTMENT_KEYWORDS = [
  "investment", "infrastructure", "energy", "mining", "concession", "tender",
  "procurement", "fintech", "startup", "funding", "PPP", "renewable", "oil",
  "gas", "agriculture", "port", "road", "railway", "power", "electricity",
  "solar", "bond", "FDI", "foreign direct", "project finance", "billion",
  "million", "economy", "GDP", "export", "trade", "regulation",
];

function isRelevant(item) {
  const text = `${item.title ?? ""} ${item.contentSnippet ?? ""}`.toLowerCase();
  return INVESTMENT_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function hashTitle(title) {
  return createHash("md5").update(title).digest("hex").slice(0, 8);
}

// Parse the suggested retry delay (seconds) from a Google API 429 error message.
function parseRetryDelay(errorMessage) {
  const match = errorMessage?.match(/Please retry in (\d+(?:\.\d+)?)s/);
  return match ? parseFloat(match[1]) * 1000 : null;
}

// Returns true if the error is a per-day quota exhaustion (not a per-minute rate limit).
function isDailyQuotaExhausted(errorMessage) {
  return (
    errorMessage?.includes("GenerateRequestsPerDayPerProjectPerModel") ||
    errorMessage?.includes("GenerateContentInputTokensPerDay")
  );
}

// Retry a Gemini call up to maxRetries times, respecting the API's suggested retry delay.
// Per-minute rate limits are retried. Per-day quota exhaustion is surfaced immediately.
async function callWithRetry(modelName, prompt, maxRetries = 2) {
  const model = genAI.getGenerativeModel({ model: modelName });
  let attempt = 0;
  while (true) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      const msg = err.message ?? "";
      if (!msg.includes("429")) throw err;
      if (isDailyQuotaExhausted(msg)) throw err; // no point retrying same-day
      if (attempt >= maxRetries) throw err;
      const waitMs = parseRetryDelay(msg) ?? Math.min(30000 * (attempt + 1), 90000);
      console.log(`    Rate limited (${modelName}). Waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
    }
  }
}

async function rewrite(item, countryHint) {
  const prompt = `You are a financial intelligence analyst writing for Frontier Capital Signals, a platform helping international investors discover opportunities in Ghana, Nigeria, Kenya, Malawi, and Uganda.

Based on this news item:
Title: ${item.title}
Source content: ${item.contentSnippet ?? item.title}

Write a concise investment intelligence brief. Rules:
- Write in a direct, confident, human tone like a senior analyst briefing a fund manager
- No em dashes (use commas or periods instead)
- No filler phrases like "In conclusion", "It is worth noting", "importantly"
- 3 short paragraphs: (1) what happened, (2) why it matters to investors, (3) what to watch next
- Keep it under 250 words total
- Return valid JSON only:
{
  "title": "compelling headline under 80 chars, investment-focused",
  "summary": "one sentence, 20-30 words, capturing the core investment signal",
  "body": "the three-paragraph analysis",
  "country": "${countryHint} or the most relevant of: Ghana, Nigeria, Kenya, Malawi, Uganda, Africa",
  "category": "one of: Infrastructure, Energy, Mining, Agriculture, Finance, Tech, Regulatory, Startup, General",
  "imageQuery": "3-4 descriptive words for an Unsplash photo that represents this topic"
}`;

  // Try primary model first, fall back to lite model if it fails with quota issues
  let text;
  try {
    text = await callWithRetry(PRIMARY_MODEL, prompt);
  } catch (primaryErr) {
    const msg = primaryErr.message ?? "";
    if (msg.includes("429")) {
      if (isDailyQuotaExhausted(msg)) {
        console.log(`  Daily quota exhausted on ${PRIMARY_MODEL}, trying ${FALLBACK_MODEL}...`);
        text = await callWithRetry(FALLBACK_MODEL, prompt);
      } else {
        throw primaryErr;
      }
    } else {
      throw primaryErr;
    }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");
  return JSON.parse(jsonMatch[0]);
}

async function processItem(item, countryHint, quotaState) {
  if (!isRelevant(item)) return null;
  try {
    return await rewrite(item, countryHint);
  } catch (err) {
    const msg = err.message ?? "";
    if (msg.includes("429") && isDailyQuotaExhausted(msg)) {
      quotaState.exhausted = true;
      console.error(`  DAILY QUOTA EXHAUSTED on both models. No further generation possible today.`);
    } else {
      console.error(`  Skipped "${item.title}": ${err.message}`);
    }
    return null;
  }
}

async function fetchImageUrl(query, slug) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (key) {
    try {
      const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query + " Africa")}&orientation=landscape&client_id=${key}`;
      const res = await fetch(url, { headers: { "Accept-Version": "v1" } });
      if (res.ok) {
        const data = await res.json();
        if (data.urls?.regular) {
          console.log(`  Image: ${data.urls.regular.split("?")[0]} (Unsplash)`);
          return data.urls.regular;
        }
      }
    } catch {
      // fall through to Picsum
    }
  }
  const picsum = `https://picsum.photos/seed/${encodeURIComponent(slug)}/1200/630`;
  console.log(`  Image: Picsum (${key ? "Unsplash failed" : "no UNSPLASH_ACCESS_KEY"})`);
  return picsum;
}

async function savePost(data) {
  const slug = `${today()}-${slugify(data.title)}-${hashTitle(data.title)}`;
  const filePath = path.join(CONTENT_DIR, `${slug}.md`);
  if (fs.existsSync(filePath)) return null;

  const imageUrl = await fetchImageUrl(data.imageQuery, slug);

  const content = `---
title: "${data.title.replace(/"/g, "'")}"
date: "${today()}"
summary: "${data.summary.replace(/"/g, "'")}"
country: "${data.country}"
category: "${data.category}"
imageQuery: "${data.imageQuery}"
image: "${imageUrl}"
---

${data.body}
`;
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`  Saved: ${slug}.md`);
  return slug;
}

async function submitToIndexNow(slugs) {
  if (slugs.length === 0) return;
  const urls = slugs.map((s) => `${SITE}/intelligence/${s}`);
  console.log(`\nSubmitting ${urls.length} URLs to IndexNow...`);
  try {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: "frontiercapitalsignals.com",
        key: INDEXNOW_KEY,
        keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
        urlList: urls,
      }),
    });
    console.log(`  IndexNow response: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error(`  IndexNow submission failed: ${err.message}`);
  }
}

async function pingSitemaps() {
  const sitemap = encodeURIComponent(`${SITE}/sitemap.xml`);
  const endpoints = [
    `https://www.bing.com/indexnow?url=${sitemap}&key=${INDEXNOW_KEY}`,
  ];
  console.log("\nPinging Bing sitemap...");
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { method: "GET" });
      console.log(`  ${new URL(url).hostname}: ${res.status}`);
    } catch (err) {
      console.error(`  Ping failed (${url}): ${err.message}`);
    }
  }
}

async function run() {
  console.log(`\nFrontier Capital Signals — Daily Intelligence Generation`);
  console.log(`Date: ${today()}`);
  console.log(`Model: ${PRIMARY_MODEL} (fallback: ${FALLBACK_MODEL})\n`);

  // Skip if today already has enough posts (prevents quota waste on manual re-runs)
  const existingToday = fs.readdirSync(CONTENT_DIR).filter((f) => f.startsWith(today()));
  if (existingToday.length >= SKIP_IF_TODAY_HAS) {
    console.log(`Already have ${existingToday.length} posts for today — skipping generation.`);
    return;
  }
  if (existingToday.length > 0) {
    console.log(`Found ${existingToday.length} existing posts for today — continuing to generate more.`);
  }

  const newSlugs = [];
  // Shared state to detect when daily quota is fully exhausted across both models
  const quotaState = { exhausted: false };

  for (const source of SOURCES) {
    if (quotaState.exhausted) {
      console.log(`\nSkipping remaining sources — daily API quota is exhausted.`);
      break;
    }
    console.log(`Fetching: ${source.url}`);
    try {
      const feed = await parser.parseURL(source.url);
      const items = feed.items.slice(0, 5);
      for (const item of items) {
        if (quotaState.exhausted) break;
        const data = await processItem(item, source.country, quotaState);
        if (data) {
          const slug = await savePost(data);
          if (slug) newSlugs.push(slug);
        }
        // Gemini free tier: 10 RPM to stay safely under the 15 RPM limit
        await new Promise((r) => setTimeout(r, 6000));
      }
    } catch (err) {
      console.error(`  Failed to fetch ${source.url}: ${err.message}`);
    }
  }

  const totalToday = existingToday.length + newSlugs.length;
  console.log(`\nGeneration complete. ${newSlugs.length} new posts (${totalToday} total for today).`);

  if (newSlugs.length > 0) {
    await submitToIndexNow(newSlugs);
  }

  await pingSitemaps();

  // Fail visibly if quota exhausted and not enough posts — prevents silent "success" with 0 content
  if (quotaState.exhausted && totalToday < MIN_NEW_POSTS) {
    console.error(
      `\nERROR: Daily Gemini API quota exhausted on both ${PRIMARY_MODEL} and ${FALLBACK_MODEL}.`
    );
    console.error(
      `Only ${totalToday} posts exist for today (need ${MIN_NEW_POSTS}).`
    );
    console.error(
      `Fix: Go to https://aistudio.google.com/ and enable billing on your Google AI project,`
    );
    console.error(
      `or wait until UTC midnight for the free tier quota to reset.`
    );
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
