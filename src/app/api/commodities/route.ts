import { NextResponse } from "next/server";

const ALLOWED_ORIGIN = "https://frontiercapitalsignals.com";

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null";
  return { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "GET", "Vary": "Origin" };
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

async function yahooQuote(symbol: string, signal: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      {
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" ? price : null;
  } catch {
    return null;
  }
}

async function getMetals(signal: AbortSignal): Promise<Record<string, number>> {
  try {
    const res = await fetch("https://api.metals.live/v1/spot", { signal });
    if (!res.ok) return {};
    const arr: Record<string, number>[] = await res.json();
    return arr.reduce((acc, obj) => ({ ...acc, ...obj }), {});
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const { signal } = controller;
    const [metals, brent, wti, natgas, cocoa, coffeeRaw, copper, cottonRaw, sugarRaw] =
      await Promise.all([
        getMetals(signal),
        yahooQuote("BZ=F", signal),   // Brent Crude, USD/bbl
        yahooQuote("CL=F", signal),   // WTI Crude, USD/bbl
        yahooQuote("NG=F", signal),   // Natural Gas, USD/MMBtu
        yahooQuote("CC=F", signal),   // Cocoa, USD/MT
        yahooQuote("KC=F", signal),   // Coffee, cents/lb → divide by 100
        yahooQuote("HG=F", signal),   // Copper, USD/lb
        yahooQuote("CT=F", signal),   // Cotton, cents/lb → divide by 100
        yahooQuote("SB=F", signal),   // Sugar No.11, cents/lb → divide by 100
      ]);

    return NextResponse.json(
      {
        precious_metals: {
          gold: metals.gold ?? null,
          silver: metals.silver ?? null,
          platinum: metals.platinum ?? null,
          palladium: metals.palladium ?? null,
        },
        base_metals: { copper },
        energy: { brent_crude: brent, wti_crude: wti, natural_gas: natgas },
        agricultural: {
          cocoa,
          coffee: coffeeRaw != null ? +(coffeeRaw / 100).toFixed(4) : null,
          cotton: cottonRaw != null ? +(cottonRaw / 100).toFixed(4) : null,
          sugar: sugarRaw != null ? +(sugarRaw / 100).toFixed(4) : null,
        },
        updated: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, max-age=900, stale-while-revalidate=300", ...corsHeaders(request.headers.get("origin")) } }
    );
  } finally {
    clearTimeout(timeout);
  }
}
