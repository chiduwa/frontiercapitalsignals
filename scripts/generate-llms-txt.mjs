/**
 * Regenerates public/llms.txt — a plain-text summary for AI systems that
 * respect llms.txt (llmstxt.org convention), listing what the site is and
 * linking its most useful pages plus the most recent intelligence articles.
 *
 * Note: robots.txt on this site deliberately blocks AI training crawlers
 * (GPTBot, ClaudeBot, Google-Extended, etc.) as a content-protection policy.
 * llms.txt is kept anyway for the overlapping-but-distinct population of
 * AI systems that respect llms.txt for retrieval/citation without treating
 * it as a training-data license — see AGENTS.md / prior audit notes for the
 * reasoning. This file does not override or loosen the robots.txt policy.
 *
 * Run: node scripts/generate-llms-txt.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(__dirname, "../content/intelligence");
const OUT_PATH = path.join(__dirname, "../public/llms.txt");
const SITE = "https://frontiercapitalsignals.com";
const RECENT_COUNT = 15;

function readFrontmatter(file) {
  const raw = fs.readFileSync(file, "utf8");
  const title = raw.match(/^title:\s*"?(.*?)"?\s*$/m)?.[1] ?? "";
  const date = raw.match(/^date:\s*"?(.*?)"?\s*$/m)?.[1] ?? "";
  const summary = raw.match(/^summary:\s*"?(.*?)"?\s*$/m)?.[1] ?? "";
  return { title, date, summary, slug: path.basename(file, ".md") };
}

function main() {
  const files = fs.existsSync(CONTENT_DIR)
    ? fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"))
    : [];
  const posts = files
    .map((f) => readFrontmatter(path.join(CONTENT_DIR, f)))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, RECENT_COUNT);

  const lines = [];
  lines.push("# Frontier Capital Signals");
  lines.push("");
  lines.push("> AI-powered investment intelligence for African markets — daily signals, due diligence support, and on-ground intelligence for investors in Ghana, Nigeria, Kenya, Malawi, and Uganda.");
  lines.push("");
  lines.push("Frontier Capital Signals publishes daily market intelligence briefs covering government procurement, tenders, energy and mining projects, regulatory changes, and investment signals across five African markets. It also offers due diligence, market-entry strategy, deal origination, and an AI Visibility Audit service for small business websites.");
  lines.push("");
  lines.push("## Key pages");
  lines.push("");
  lines.push(`- [Home](${SITE}/): Overview and daily intelligence highlights`);
  lines.push(`- [Intelligence](${SITE}/intelligence): Full archive of daily market intelligence articles`);
  lines.push(`- [Services](${SITE}/services): Due diligence, market entry, deal origination, and intelligence subscriptions`);
  lines.push(`- [Markets](${SITE}/markets): Coverage by country`);
  lines.push(`- [About](${SITE}/about): Company background`);
  lines.push(`- [AI Visibility Audit](${SITE}/audit): Fixed-price analytics and AI-search-visibility audit service for small business websites`);
  lines.push(`- [Free AI Visibility Scan](${SITE}/scan): Free automated scan of a website's analytics, structured data, and AI-crawler readiness`);
  lines.push(`- [Contact](${SITE}/contact)`);
  lines.push("");
  lines.push(`## Recent intelligence (latest ${posts.length})`);
  lines.push("");
  for (const p of posts) {
    const desc = p.summary ? `: ${p.summary}` : "";
    lines.push(`- [${p.title || p.slug}](${SITE}/intelligence/${p.slug})${desc}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("This file is regenerated weekly. It does not grant any permission beyond what robots.txt allows — see robots.txt for crawler access rules.");
  lines.push("");

  fs.writeFileSync(OUT_PATH, lines.join("\n"));
  console.log(`Wrote ${OUT_PATH} with ${posts.length} recent articles.`);
}

main();
