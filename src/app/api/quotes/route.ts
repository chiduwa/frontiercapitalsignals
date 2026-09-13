import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { sharesFor } from "@/lib/shares";

/**
 * Live-ish quotes for the four African exchanges that publish machine-readable
 * price data, joined to USD via the same FX source as /api/rates.
 *
 * Three sources are fetched live at the edge (NGX, USE, MSE); Ghana is served
 * from KV because its upstream blocks Cloudflare — see fetchGse below.
 *
 * These are end-of-day / delayed prices, not real time — every upstream here is
 * the exchange's own public board or its documented API. Kenya is absent by
 * necessity: the NSE publishes no open endpoint (its ticker API rejects
 * unregistered callers), so Kenyan listings stay reference-only.
 *
 * Market capitalisation comes from the feed where the exchange publishes it
 * (Uganda), and is otherwise derived as shares outstanding x price — see
 * src/lib/shares.ts for why NGX and MSE currently have none.
 */

const ALLOWED_ORIGIN = "https://frontiercapitalsignals.com";

// Currencies the five markets quote in. KES is fetched for completeness even
// though Kenya carries no quotes, so the client can still format Kenyan text.
const CURRENCIES = ["GHS", "NGN", "KES", "MWK", "UGX"] as const;

const UPSTREAM_TIMEOUT_MS = 9000;

type Quote = {
  price: number;
  change: number | null;
  changePct: number | null;
  marketCap: number | null;
  volume: number | null;
};

type QuoteMap = Record<string, Quote>;

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET",
    Vary: "Origin",
  };
}

async function fetchWithTimeout(url: string, accept = "application/json") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: accept,
        // Several of these hosts reject requests without a browser-ish agent.
        "User-Agent": "Mozilla/5.0 (compatible; FrontierCapitalSignals/1.0)",
      },
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ghana — read from KV, not fetched directly.
 *
 * dev.kwayisi.org, which publishes the GSE board, refuses connections from
 * Cloudflare's egress: every request from a Worker times out, at 9s and at 25s,
 * from every colo tested, while the same request succeeds instantly from a
 * laptop or a GitHub runner. So .github/workflows/gse-quotes.yml pulls the feed
 * on a schedule and writes it here. Do not "restore" a direct fetch — it will
 * pass local testing and then hang in production.
 *
 * Market cap is derived from the stored share counts in src/lib/shares.ts.
 */
type GseCache = {
  fetchedAt: string;
  rows: { name: string; price: number; change: number; volume: number }[];
};

/**
 * How stale the cached Ghana board may be before it is withheld. Two trading
 * days plus a margin: enough to ride out a weekend or a failed refresh, short
 * enough that nobody is shown a week-old price as though it were current.
 */
const GSE_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

async function fetchGse(): Promise<QuoteMap> {
  const { env } = getCloudflareContext();
  const cached = await env.FCS_QUOTES?.get<GseCache>("gse:live", "json");
  if (!cached?.rows?.length) throw new Error("GSE: no cached board in KV");

  // Serving a stale board unlabelled is worse than serving none: withhold it and
  // let Ghana fall back to reference-only, which the client renders explicitly.
  const age = Date.now() - Date.parse(cached.fetchedAt);
  if (!Number.isFinite(age) || age > GSE_MAX_AGE_MS) {
    throw new Error(`GSE: cached board is stale (${Math.round(age / 3600000)}h old)`);
  }

  const out: QuoteMap = {};
  for (const r of cached.rows) {
    if (typeof r?.price !== "number") continue;
    const shares = sharesFor("gse", r.name);
    out[r.name] = {
      price: r.price,
      change: null,
      // The GSE feed reports `change` already as a percentage.
      changePct: typeof r.change === "number" ? r.change : null,
      marketCap: shares ? shares * r.price : null,
      volume: typeof r.volume === "number" ? r.volume : null,
    };
  }
  return out;
}

/** Nigeria — NGX's own REST API, the one that powers ngxgroup.com. */
async function fetchNgx(): Promise<QuoteMap> {
  const res = await fetchWithTimeout(
    "https://doclib.ngxgroup.com/REST/api/statistics/equities/?market=&sector=&orderby=&pageSize=400&pageNo=0"
  );
  const rows = (await res.json()) as {
    Symbol: string;
    ClosePrice: number;
    PrevClosingPrice: number;
    Change: number;
    PercChange: number;
    Volume: number;
  }[];

  const out: QuoteMap = {};
  for (const r of rows) {
    const ticker = String(r?.Symbol ?? "").trim();
    const price = Number(r?.ClosePrice);
    if (!ticker || !Number.isFinite(price)) continue;
    const shares = sharesFor("ngx", ticker);
    out[ticker] = {
      price,
      change: Number.isFinite(Number(r.Change)) ? Number(r.Change) : null,
      changePct: Number.isFinite(Number(r.PercChange)) ? Number(r.PercChange) : null,
      marketCap: shares ? shares * price : null,
      volume: Number.isFinite(Number(r.Volume)) ? Number(r.Volume) : null,
    };
  }
  return out;
}

/**
 * Uganda — the exchange's own delayed-data endpoint, which publishes market
 * capitalisation directly. Its `stock` field carries display names rather than
 * tickers for some counters, and it mixes in bonds and index rows.
 */
const USE_NAME_TO_TICKER: Record<string, string> = {
  "AIRTEL UGANDA": "AIRTEL",
};

async function fetchUse(): Promise<QuoteMap> {
  const res = await fetchWithTimeout("https://www.use.or.ug/api/delayed-data");
  const rows = (await res.json()) as {
    type: string;
    stock: string;
    price: number;
    market_cap: number;
    volume: number;
  }[];

  const out: QuoteMap = {};
  for (const r of rows) {
    const raw = String(r?.stock ?? "").trim();
    // Skip government bonds (FXD...) and the ALSI / LCI index rows.
    if (!raw || raw.startsWith("FXD") || raw === "ALSI" || raw === "LCI") continue;
    const ticker = USE_NAME_TO_TICKER[raw] ?? raw;
    if (!Number.isFinite(Number(r.price))) continue;
    out[ticker] = {
      price: Number(r.price),
      change: null,
      changePct: null,
      marketCap: Number.isFinite(Number(r.market_cap)) ? Number(r.market_cap) : null,
      volume: Number.isFinite(Number(r.volume)) ? Number(r.volume) : null,
    };
  }
  return out;
}

/**
 * Malawi — the MSE publishes no API, but its homepage carries the full main
 * board price table server-rendered, so it is parsed out of the markup. Scoped
 * to the main board so the Treasury notes below it are not picked up.
 *
 * NOTE: mse.co.mw serves only its leaf certificate, omitting the Let's Encrypt
 * intermediate. Cloudflare's edge resolves the chain and this works in
 * production, but Node (`next dev` / `next start`) and local `workerd` both
 * reject it, so this source shows as unavailable in local development. That is
 * expected — do not "fix" it by weakening verification. Verified against a
 * deployed Worker, September 2026.
 */
async function fetchMse(): Promise<QuoteMap> {
  const res = await fetchWithTimeout("https://mse.co.mw/", "text/html");
  const html = await res.text();

  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "|")
    // The board separates price from change with a literal &nbsp; entity; decode
    // it (and the other common entities) before matching, or every row misses.
    .replace(/&nbsp;|&#160;|\u00a0/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/(\|\s*)+/g, "|");

  const start = text.indexOf("Main Board");
  const end = text.indexOf("Debt Securities Market");
  if (start === -1) throw new Error("MSE: main board table not found");
  const segment = text.slice(start, end === -1 ? undefined : end);

  const out: QuoteMap = {};
  const row = /\|([A-Z]{2,9})\|\s*([\d,]+\.\d+)\s*\|\s*\(\s*([-\d.]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = row.exec(segment)) !== null) {
    const price = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(price)) continue;
    const shares = sharesFor("mse", m[1]);
    out[m[1]] = {
      price,
      change: null,
      changePct: Number.isFinite(Number(m[3])) ? Number(m[3]) : null,
      marketCap: shares ? shares * price : null,
      volume: null,
    };
  }
  if (Object.keys(out).length === 0) throw new Error("MSE: no rows parsed");
  return out;
}

async function fetchFx(): Promise<Record<string, number>> {
  const res = await fetchWithTimeout("https://open.er-api.com/v6/latest/USD");
  const data = (await res.json()) as { result: string; rates: Record<string, number> };
  if (data.result !== "success") throw new Error("FX: bad response");
  return Object.fromEntries(
    CURRENCIES.map((c) => [c, data.rates[c]]).filter(([, v]) => typeof v === "number")
  ) as Record<string, number>;
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function GET(request: Request) {
  const cors = corsHeaders(request.headers.get("origin"));

  // One slow or broken exchange must not take the whole board down, so each
  // upstream is settled independently and reported per-source.
  const [fx, gse, ngx, use, mse] = await Promise.allSettled([
    fetchFx(),
    fetchGse(),
    fetchNgx(),
    fetchUse(),
    fetchMse(),
  ]);

  if (fx.status === "rejected") {
    // Without FX there is no USD column, which is the point of this endpoint.
    return NextResponse.json({ error: "fx unavailable" }, { status: 503, headers: cors });
  }

  const settled = { gse, ngx, use, mse } as const;
  const quotes: Record<string, QuoteMap> = {};
  const sources: Record<string, "ok" | "unavailable"> = {};

  for (const [id, result] of Object.entries(settled)) {
    if (result.status === "fulfilled") {
      quotes[id] = result.value;
      sources[id] = "ok";
    } else {
      quotes[id] = {};
      sources[id] = "unavailable";
    }
  }

  return NextResponse.json(
    {
      asOf: new Date().toISOString(),
      fx: fx.value,
      sources,
      quotes,
    },
    {
      headers: {
        // Every upstream is end-of-day, so an hour of cache costs no freshness.
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=1800",
        ...cors,
      },
    }
  );
}
