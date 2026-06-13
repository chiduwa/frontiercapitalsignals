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

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const parser = new RSSParser({ timeout: 10000 });

const SITE = "https://frontiercapitalsignals.com";
const INDEXNOW_KEY = "fcs3902425740540825";

const SOURCES = [
  { url: "https://www.theafricareport.com/feed/", country: "Africa" },
  { url: "https://businessday.ng/feed/", country: "Nigeria" },
  { url: "https://www.ghanabusinessnews.com/feed/", country: "Ghana" },
  { url: "https://www.businessdailyafrica.com/bd/feeds/-/539634/feed/xml", country: "Kenya" },
  { url: "https://www.theeastafrican.co.ke/tea/business/-/2560/feed/xml", country: "Kenya" },
  { url: "https://www.malawitimes.com/feed/", country: "Malawi" },
  { url: "https://www.newvision.co.ug/category/business/feed/", country: "Uganda" },
  { url: "https://africabusinesscommunities.com/feed/", country: "Africa" },
  { url: "https://www.itnewsafrica.com/feed/", country: "Africa" },
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

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");
  return JSON.parse(jsonMatch[0]);
}

async function processItem(item, countryHint) {
  if (!isRelevant(item)) return null;
  try {
    return await rewrite(item, countryHint);
  } catch (err) {
    console.error(`  Skipped "${item.title}": ${err.message}`);
    return null;
  }
}

function savePost(data) {
  const slug = `${today()}-${slugify(data.title)}-${hashTitle(data.title)}`;
  const filePath = path.join(CONTENT_DIR, `${slug}.md`);
  if (fs.existsSync(filePath)) return null;

  const content = `---
title: "${data.title.replace(/"/g, "'")}"
date: "${today()}"
summary: "${data.summary.replace(/"/g, "'")}"
country: "${data.country}"
category: "${data.category}"
imageQuery: "${data.imageQuery}"
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
    `https://www.google.com/ping?sitemap=${sitemap}`,
    `https://www.bing.com/indexnow?url=${sitemap}&key=${INDEXNOW_KEY}`,
  ];
  console.log("\nPinging search engine sitemaps...");
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
  console.log(`Date: ${today()}\n`);

  const newSlugs = [];

  for (const source of SOURCES) {
    console.log(`Fetching: ${source.url}`);
    try {
      const feed = await parser.parseURL(source.url);
      const items = feed.items.slice(0, 5);
      for (const item of items) {
        const data = await processItem(item, source.country);
        if (data) {
          const slug = savePost(data);
          if (slug) newSlugs.push(slug);
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    } catch (err) {
      console.error(`  Failed to fetch ${source.url}: ${err.message}`);
    }
  }

  console.log(`\nGeneration complete. ${newSlugs.length} new posts.`);

  if (newSlugs.length > 0) {
    await submitToIndexNow(newSlugs);
  }

  await pingSitemaps();
}

run().catch(console.error);
