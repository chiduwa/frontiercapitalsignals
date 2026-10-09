/**
 * Daily intelligence generation script.
 * Fetches Africa investment news from RSS, rewrites with Gemini, saves as Markdown.
 * IndexNow submission happens after the deploy (scripts/indexnow-after-deploy.mjs),
 * once the new URLs actually return 200.
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
  { url: "https://www.theafricareport.com/feed/", country: "Africa", name: "The Africa Report" },
  { url: "https://businessday.ng/feed/", country: "Nigeria", name: "BusinessDay" },
  { url: "https://www.premiumtimesng.com/feed", country: "Nigeria", name: "Premium Times" },
  { url: "https://citibusinessnews.com/feed/", country: "Ghana", name: "Citi Business News" },
  { url: "https://thebftonline.com/feed/", country: "Ghana", name: "The B&FT" },
  { url: "https://www.nyasatimes.com/feed/", country: "Malawi", name: "Nyasa Times" },
  { url: "https://malawi24.com/feed/", country: "Malawi", name: "Malawi24" },
  { url: "https://www.itnewsafrica.com/feed/", country: "Africa", name: "IT News Africa" },
  { url: "https://africabriefing.com/feed/", country: "Africa", name: "Africa Briefing" },
];

// Items older than this are news someone has already acted on.
const MAX_ITEM_AGE_HOURS = 72;

const INVESTMENT_KEYWORDS = [
  "investment", "infrastructure", "energy", "mining", "concession", "tender",
  "procurement", "fintech", "startup", "funding", "PPP", "renewable", "oil",
  "gas", "agriculture", "port", "road", "railway", "power", "electricity",
  "solar", "bond", "FDI", "foreign direct", "project finance", "economy",
  "GDP", "export", "trade", "regulation",
];

// Whole words only, with plurals: substring matching let "port" match
// "sport", "report" and "support", "oil" match "turmoil", "gas" match "Vegas",
// so football and court stories were briefed as investment signals. "million"
// and "billion" are gone as triggers: a sum of money alone is not a business
// or policy event.
const KEYWORD_PATTERNS = INVESTMENT_KEYWORDS.map(
  (kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`, "i"),
);

function isRelevant(item) {
  const text = `${item.title ?? ""} ${item.contentSnippet ?? ""}`;
  return KEYWORD_PATTERNS.some((re) => re.test(text));
}

function isFresh(item) {
  const published = Date.parse(item.isoDate ?? item.pubDate ?? "");
  if (Number.isNaN(published)) return true; // undated items are judged by the model and dedupe
  return Date.now() - published <= MAX_ITEM_AGE_HOURS * 3600 * 1000;
}

function normalizeUrl(link) {
  try {
    const u = new URL(link);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, "");
  } catch {
    return (link ?? "").trim();
  }
}

// Source URLs already briefed, from every stored post's frontmatter.
function knownSourceUrls() {
  const seen = new Set();
  for (const f of fs.readdirSync(CONTENT_DIR).filter((n) => n.endsWith(".md"))) {
    const m = fs.readFileSync(path.join(CONTENT_DIR, f), "utf8").match(/^sourceUrl:\s*"([^"]+)"/m);
    if (m) seen.add(normalizeUrl(m[1]));
  }
  return seen;
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

async function rewrite(item, countryHint, sourceName) {
  const prompt = `You are a financial intelligence analyst writing for Frontier Capital Signals, a platform helping international investors discover opportunities in Ghana, Nigeria, Kenya, Malawi, and Uganda.

Based on this news item from ${sourceName}:
Title: ${item.title}
Source content: ${item.contentSnippet ?? item.title}

First decide whether it describes a business, market, policy or investment event that an investor in these markets could act on. Sport, crime, celebrity, court and party-politics stories without a clear business or policy consequence are not relevant. If it is not relevant, return exactly {"relevant": false}.

Otherwise write a concise investment intelligence brief. Rules:
- Use only facts stated in the source content above. Do not add numbers, names, dates, quotes or outcomes that are not in it
- Attribute reported facts to ${sourceName} (for example "${sourceName} reports that ...")
- Write in a direct, plain, human tone like a senior analyst briefing a fund manager; state uncertainty where the source is thin
- No em dashes (use commas or periods instead)
- No filler phrases like "In conclusion", "It is worth noting", "importantly"
- 2 or 3 short paragraphs: (1) what happened, (2) why it matters to investors, (3) what to watch next
- Between 100 and 220 words. If the source content is brief, write less rather than padding it
- Return valid JSON only:
{
  "relevant": true,
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

async function processItem(item, countryHint, sourceName, quotaState) {
  if (!isRelevant(item)) return null;
  try {
    const data = await rewrite(item, countryHint, sourceName);
    if (data.relevant === false) {
      console.log(`  Not investment-relevant (model): "${item.title}"`);
      return null;
    }
    return data;
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
  // Deliberately no placeholder: a random picsum.photos shot bears no relation
  // to the report, and once written into frontmatter it becomes the article's
  // og:image and its Article schema image — a stock photo standing in as the
  // illustration of a financial intelligence report on every social card, chat
  // citation and search result. Returning null lets the per-article
  // opengraph-image route render the headline on the site's own card instead.
  console.log(`  Image: none (${key ? "Unsplash failed" : "no UNSPLASH_ACCESS_KEY"}); generated card will be used`);
  return null;
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
imageQuery: "${data.imageQuery}"${imageUrl ? `\nimage: "${imageUrl}"` : ""}
source: "${data.source.replace(/"/g, "'")}"
sourceUrl: "${data.sourceUrl.replace(/"/g, "%22")}"${data.sourcePublished ? `\nsourcePublished: "${data.sourcePublished}"` : ""}
---

${data.body}
`;
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`  Saved: ${slug}.md`);
  return slug;
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
  const briefedUrls = knownSourceUrls();
  console.log(`${briefedUrls.size} source URLs already briefed.`);

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
        const link = normalizeUrl(item.link ?? "");
        if (!link) continue;
        if (briefedUrls.has(link)) { console.log(`  Already briefed: ${link}`); continue; }
        if (!isFresh(item)) { console.log(`  Older than ${MAX_ITEM_AGE_HOURS}h: "${item.title}"`); continue; }
        const data = await processItem(item, source.country, source.name, quotaState);
        if (data) {
          data.source = source.name;
          data.sourceUrl = link;
          const published = Date.parse(item.isoDate ?? item.pubDate ?? "");
          data.sourcePublished = Number.isNaN(published) ? "" : new Date(published).toISOString().slice(0, 10);
          const slug = await savePost(data);
          if (slug) { newSlugs.push(slug); briefedUrls.add(link); }
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
