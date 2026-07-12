import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type CheckStatus = "pass" | "warn" | "fail";
interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  points: number;
  maxPoints: number;
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 3_000_000;
const USER_AGENT = "FCS-AIVisibilityScanner/1.0 (+https://frontiercapitalsignals.com/audit)";
const AI_CRAWLERS = ["GPTBot", "Google-Extended", "PerplexityBot", "ClaudeBot", "anthropic-ai", "CCBot", "Applebot-Extended"];

// Isolate-scoped rate limit: this is a public, unauthenticated endpoint that makes
// up to 3 outbound fetches per call, so it's both a cost-abuse and an
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
  hits.push(now);
  rateLimitHits.set(clientId, hits);
  // Opportunistic cleanup so the map doesn't grow unbounded within a long-lived isolate.
  if (rateLimitHits.size > 5000) {
    for (const [key, times] of rateLimitHits) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) rateLimitHits.delete(key);
    }
  }
  return hits.length > RATE_LIMIT_MAX;
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

function isUnsafeIpv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback / this-network
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isSafeHostname(hostname: string): boolean {
  // WHATWG URL keeps brackets on IPv6 literals (e.g. "[::1]") — strip them
  // before comparing, otherwise every IPv6-literal check below silently no-ops.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "0.0.0.0") return false;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return !isUnsafeIpv4(Number(ipv4[1]), Number(ipv4[2]));
  }

  if (host.includes(":")) {
    // IPv6 literal.
    if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1" || host === "0:0:0:0:0:0:0:0") {
      return false;
    }
    // IPv4-mapped/compatible addresses (::ffff:127.0.0.1 or ::ffff:7f00:1) — pull
    // out the embedded IPv4 and re-check it so mapped metadata/loopback addresses
    // don't sneak past the IPv4 branch above.
    const mappedDotted = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (mappedDotted) {
      return !isUnsafeIpv4(Number(mappedDotted[1]), Number(mappedDotted[2]));
    }
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const a = parseInt(mappedHex[1].padStart(4, "0").slice(0, 2), 16);
      const b = parseInt(mappedHex[1].padStart(4, "0").slice(2, 4), 16);
      return !isUnsafeIpv4(a, b);
    }
    // Link-local (fe80::/10) and unique local (fc00::/7) — reject by first hextet.
    const firstGroup = host.split(":").find((g) => g.length > 0) ?? "";
    if (/^[0-9a-f]{1,4}$/.test(firstGroup)) {
      const groupNum = parseInt(firstGroup.padStart(4, "0"), 16);
      if ((groupNum & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
      if ((groupNum & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    }
    return true;
  }

  return true;
}

async function safeFetch(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    const lenHeader = res.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > MAX_BYTES) {
      return { ok: false, text: "", status: res.status };
    }
    const text = await res.text();
    return { ok: res.ok, text: text.slice(0, MAX_BYTES), status: res.status };
  } catch {
    return { ok: false, text: "", status: 0 };
  } finally {
    clearTimeout(timeout);
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
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const target = normalizeUrl(body.url ?? "");
  if (!target || !["http:", "https:"].includes(target.protocol)) {
    return NextResponse.json({ error: "Enter a valid website URL." }, { status: 400 });
  }
  if (!isSafeHostname(target.hostname)) {
    return NextResponse.json({ error: "That host can't be scanned." }, { status: 400 });
  }

  const selfHost = req.headers.get("host")?.split(":")[0]?.toLowerCase();
  if (selfHost && target.hostname.toLowerCase() === selfHost) {
    return NextResponse.json(
      { error: "This tool can't scan the site it's hosted on — Cloudflare Workers can't fetch their own domain. Try a different site." },
      { status: 400 },
    );
  }

  const origin = `${target.protocol}//${target.hostname}`;
  const [pageRes, robotsRes, llmsRes] = await Promise.all([
    safeFetch(target.toString()),
    safeFetch(`${origin}/robots.txt`),
    safeFetch(`${origin}/llms.txt`),
  ]);

  if (!pageRes.ok) {
    return NextResponse.json({ error: `Couldn't reach that site (got a ${pageRes.status || "network error"}). Check the URL and try again.` }, { status: 422 });
  }

  const html = pageRes.text;
  const checks: Check[] = [];

  // --- Analytics ---
  const hasGtm = /googletagmanager\.com\/gtm\.js/i.test(html);
  const hasGa4 = /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i.test(html);
  const hasLegacyUa = /UA-\d{4,}-\d+/i.test(html) && !hasGa4 && !hasGtm;
  if (hasGtm || hasGa4) {
    addCheck(checks, { id: "analytics", label: "Analytics tracking (GA4/GTM)", status: "pass", detail: hasGtm ? "Google Tag Manager container detected." : "GA4 tag detected.", points: 20, maxPoints: 20 });
  } else if (hasLegacyUa) {
    addCheck(checks, { id: "analytics", label: "Analytics tracking (GA4/GTM)", status: "warn", detail: "Only legacy Universal Analytics (UA-) found — this stopped collecting data in 2023 and needs migrating to GA4.", points: 5, maxPoints: 20 });
  } else {
    addCheck(checks, { id: "analytics", label: "Analytics tracking (GA4/GTM)", status: "fail", detail: "No GA4 or Google Tag Manager tag detected on the homepage.", points: 0, maxPoints: 20 });
  }

  // --- Structured data ---
  const hasSchema = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  addCheck(checks, {
    id: "schema", label: "Structured data (schema.org)", status: hasSchema ? "pass" : "fail",
    detail: hasSchema ? "Found JSON-LD structured data — this is what AI engines and Google use to understand your business." : "No JSON-LD structured data found. AI engines rely heavily on this to describe your business accurately.",
    points: hasSchema ? 15 : 0, maxPoints: 15,
  });

  // --- Title ---
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";
  const titleOk = title.length >= 10 && title.length <= 70;
  addCheck(checks, {
    id: "title", label: "Page title", status: title ? (titleOk ? "pass" : "warn") : "fail",
    detail: title ? (titleOk ? `"${title}"` : `Title is ${title.length} characters — aim for 10-70.`) : "No <title> tag found.",
    points: title ? (titleOk ? 10 : 6) : 0, maxPoints: 10,
  });

  // --- Meta description ---
  const hasMetaDesc = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}["']/i.test(html);
  addCheck(checks, {
    id: "meta-description", label: "Meta description", status: hasMetaDesc ? "pass" : "fail",
    detail: hasMetaDesc ? "Present with meaningful content." : "Missing or too short — this is the snippet AI engines and search results quote.",
    points: hasMetaDesc ? 10 : 0, maxPoints: 10,
  });

  // --- Canonical ---
  const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  addCheck(checks, {
    id: "canonical", label: "Canonical tag", status: hasCanonical ? "pass" : "warn",
    detail: hasCanonical ? "Present." : "No canonical tag found — can cause duplicate-content confusion.",
    points: hasCanonical ? 10 : 3, maxPoints: 10,
  });

  // --- Open Graph ---
  const hasOg = /<meta[^>]+property=["']og:title["']/i.test(html);
  addCheck(checks, {
    id: "opengraph", label: "Open Graph / social preview tags", status: hasOg ? "pass" : "warn",
    detail: hasOg ? "Present." : "Missing — links shared on social/chat apps won't show a proper preview.",
    points: hasOg ? 10 : 3, maxPoints: 10,
  });

  // --- robots.txt / AI crawlers ---
  if (robotsRes.ok && robotsRes.text) {
    const robotsTxt = robotsRes.text;
    const blockedBots: string[] = [];
    for (const bot of AI_CRAWLERS) {
      const re = new RegExp(`User-agent:\\s*${bot}[\\s\\S]{0,60}?Disallow:\\s*/(?!\\S)`, "i");
      if (re.test(robotsTxt)) blockedBots.push(bot);
    }
    if (blockedBots.length === 0) {
      addCheck(checks, { id: "ai-crawlers", label: "AI crawler access (robots.txt)", status: "pass", detail: "No major AI crawlers are blocked.", points: 15, maxPoints: 15 });
    } else {
      addCheck(checks, { id: "ai-crawlers", label: "AI crawler access (robots.txt)", status: "warn", detail: `Blocking: ${blockedBots.join(", ")}. Intentional if you don't want AI training on your content — but it also blocks you from appearing in AI answer engines.`, points: 5, maxPoints: 15 });
    }
  } else {
    addCheck(checks, { id: "ai-crawlers", label: "AI crawler access (robots.txt)", status: "warn", detail: "No robots.txt found.", points: 5, maxPoints: 15 });
  }

  // --- llms.txt ---
  const hasLlms = llmsRes.ok && llmsRes.text.length > 0;
  addCheck(checks, {
    id: "llms-txt", label: "llms.txt (AI-crawler guidance file)", status: hasLlms ? "pass" : "warn",
    detail: hasLlms ? "Present — helps AI engines summarize your site correctly." : "Not found. This is a new, low-effort file that helps AI answer engines summarize your site.",
    points: hasLlms ? 10 : 0, maxPoints: 10,
  });

  const score = checks.reduce((sum, c) => sum + c.points, 0);
  const maxScore = checks.reduce((sum, c) => sum + c.maxPoints, 0);
  const pct = Math.round((score / maxScore) * 100);
  const grade = pct >= 80 ? "Strong" : pct >= 50 ? "Needs Work" : "High Risk";

  return NextResponse.json({
    url: target.toString(),
    score: pct,
    grade,
    checks,
  });
}
