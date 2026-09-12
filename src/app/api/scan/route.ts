import { NextRequest, NextResponse } from "next/server";
import { isAllowedScanUrl, readBoundedText, safeFetch } from "@/lib/scanner-fetch";

export const dynamic = "force-dynamic";

type CheckStatus = "pass" | "warn" | "fail" | "info";
interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  points: number;
  maxPoints: number;
}

// Isolate-scoped rate limit: this is a public, unauthenticated endpoint that makes
// up to 2 resources (at most 4 requests each with validated redirects), so it's both a cost-abuse and an
// SSRF/fetch-relay-abuse vector without some cap. Cloudflare Workers reuse an
// isolate across many requests from the same edge colo, so a plain in-memory
// map (same pattern already used in api/commodities) meaningfully throttles a
// single abusive client even though it isn't a global/durable limit across
// every isolate. A KV- or Durable-Object-backed limiter would be sturdier if
// abuse is observed in practice.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 6;
const rateLimitHits = new Map<string, number[]>();

function isRateLimited(clientId: string): boolean {
  const now = Date.now();
  const hits = (rateLimitHits.get(clientId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  const limited = hits.length >= RATE_LIMIT_MAX;
  if (!limited) hits.push(now);
  if (rateLimitHits.size >= 5000 && !rateLimitHits.has(clientId)) {
    for (const [key, times] of rateLimitHits) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateLimitHits.delete(key);
    }
    if (rateLimitHits.size >= 5000) return true;
  }
  rateLimitHits.set(clientId, hits);
  // Opportunistic cleanup so the map doesn't grow unbounded within a long-lived isolate.
  if (rateLimitHits.size > 5000) {
    for (const [key, times] of rateLimitHits) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateLimitHits.delete(key);
    }
  }
  return limited;
}

function normalizeUrl(input: string): URL | null {
  let candidate = input.trim();
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}


function addCheck(checks: Check[], check: Check) {
  checks.push(check);
}

export async function POST(req: NextRequest) {
  const clientId = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (isRateLimited(clientId)) {
    return NextResponse.json(
      { error: "Too many scans from this connection. Try again in a minute." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: { url?: string };
  try {
    const parsed: unknown = JSON.parse(await readBoundedText(req.body, 4096));
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { url?: unknown }).url !== "string") {
      return NextResponse.json({ error: "Enter a website URL." }, { status: 400 });
    }
    body = parsed as { url: string };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const target = normalizeUrl(body.url ?? "");
  if (!target || !["http:", "https:"].includes(target.protocol)) {
    return NextResponse.json({ error: "Enter a valid website URL." }, { status: 400 });
  }
  if (!isAllowedScanUrl(target)) {
    return NextResponse.json({ error: "That host can't be scanned." }, { status: 400 });
  }

  const selfHost = req.headers.get("host")?.split(":")[0]?.toLowerCase();
  if (selfHost && target.hostname.toLowerCase() === selfHost) {
    return NextResponse.json(
      { error: "This tool can't scan the site it's hosted on. Cloudflare Workers can't fetch their own domain. Try a different site." },
      { status: 400 },
    );
  }

  const origin = target.origin;
  const [pageRes, robotsRes] = await Promise.all([
    safeFetch(target.toString()),
    safeFetch(`${origin}/robots.txt`),
  ]);

  if (!pageRes.ok) {
    return NextResponse.json({ error: `Couldn't reach that site (got a ${pageRes.status || "network error"}). Use the final public page URL after any redirects and try again.` }, { status: 422 });
  }

  const html = pageRes.text;
  const checks: Check[] = [];

  // --- Analytics ---
  const hasGtm = /googletagmanager\.com\/gtm\.js/i.test(html);
  const hasGa4 = /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i.test(html);
  const hasLegacyUa = /UA-\d{4,}-\d+/i.test(html) && !hasGa4 && !hasGtm;
  if (hasGtm || hasGa4) {
    addCheck(checks, { id: "analytics", label: "Analytics tracking (GA4/GTM)", status: "pass", detail: hasGtm ? "Google Tag Manager container detected." : "GA4 tag detected.", points: 0, maxPoints: 0 });
  } else if (hasLegacyUa) {
    addCheck(checks, { id: "analytics", label: "Analytics tracking (GA4/GTM)", status: "warn", detail: "Only legacy Universal Analytics (UA-) found. this stopped collecting data in 2023 and needs migrating to GA4.", points: 0, maxPoints: 0 });
  } else {
    addCheck(checks, { id: "analytics", label: "Analytics tracking (GA4/GTM)", status: "info", detail: "No GA4 or Google Tag Manager tag detected in the page HTML. Other analytics may be in use. Analytics tags are not a search visibility requirement.", points: 0, maxPoints: 0 });
  }

  // --- Structured data ---
  const hasSchema = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  addCheck(checks, {
    id: "schema", label: "Structured data (schema.org)", status: hasSchema ? "pass" : "fail",
    detail: hasSchema ? "JSON-LD detected. This check does not validate its accuracy or eligibility for rich results." : "No JSON-LD detected. Relevant, accurate structured data can clarify page content, but is not required for Google AI features.",
    points: hasSchema ? 15 : 0, maxPoints: 15,
  });

  // --- Title ---
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";
  const titleOk = title.length >= 10 && title.length <= 70;
  addCheck(checks, {
    id: "title", label: "Page title", status: title ? (titleOk ? "pass" : "warn") : "fail",
    detail: title ? (titleOk ? `"${title}"` : `Title is ${title.length} characters. aim for 10-70.`) : "No <title> tag found.",
    points: title ? (titleOk ? 10 : 6) : 0, maxPoints: 10,
  });

  // --- Meta description ---
  const hasMetaDesc = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}["']/i.test(html);
  addCheck(checks, {
    id: "meta-description", label: "Meta description", status: hasMetaDesc ? "pass" : "fail",
    detail: hasMetaDesc ? "Present with meaningful content." : "Missing or short. A useful description can inform search snippets, although search engines may select different text.",
    points: hasMetaDesc ? 10 : 0, maxPoints: 10,
  });

  // --- Canonical ---
  const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  addCheck(checks, {
    id: "canonical", label: "Canonical tag", status: hasCanonical ? "pass" : "warn",
    detail: hasCanonical ? "Present." : "No canonical tag found. can cause duplicate-content confusion.",
    points: hasCanonical ? 10 : 3, maxPoints: 10,
  });

  // --- Open Graph ---
  const hasOg = /<meta[^>]+property=["']og:title["']/i.test(html);
  addCheck(checks, {
    id: "opengraph", label: "Open Graph / social preview tags", status: hasOg ? "pass" : "warn",
    detail: hasOg ? "Present." : "Missing. links shared on social/chat apps won't show a proper preview.",
    points: hasOg ? 10 : 3, maxPoints: 10,
  });

  // Access policies are informational, not a ranking or training-permission score.
  const hasRobots = robotsRes.ok && robotsRes.text.length > 0 && !/<html/i.test(robotsRes.text);
  addCheck(checks, {
    id: "robots", label: "Crawler policy", status: "info",
    detail: hasRobots
      ? "robots.txt is available. This check does not parse every rule or verify crawler access. Search and training controls differ: GPTBot is separate from OAI-SearchBot, and Google-Extended does not control Google Search."
      : "robots.txt was not confirmed at this URL. Its absence alone does not prevent indexing. Review crawler policies separately from training preferences.",
    points: 0, maxPoints: 0,
  });

  const score = checks.reduce((sum, c) => sum + c.points, 0);
  const maxScore = checks.reduce((sum, c) => sum + c.maxPoints, 0);
  const pct = Math.round((score / maxScore) * 100);
  const grade = pct >= 80 ? "Most checks passed" : pct >= 50 ? "Some checks need review" : "Several checks need review";

  return NextResponse.json({
    url: target.toString(),
    score: pct,
    grade,
    checks,
  });
}
