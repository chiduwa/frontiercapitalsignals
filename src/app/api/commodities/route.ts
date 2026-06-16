export const runtime = "edge";

import { NextResponse } from "next/server";

async function yahooQuote(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      {
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

async function getMetals(): Promise<Record<string, number>> {
  try {
    const res = await fetch("https://api.metals.live/v1/spot");
    if (!res.ok) return {};
    const arr: Record<string, number>[] = await res.json();
    return arr.reduce((acc, obj) => ({ ...acc, ...obj }), {});
  } catch {
    return {};
  }
}

export async function GET() {
  const [metals, brent, wti, natgas, cocoa, coffeeRaw, copper, cottonRaw, sugarRaw] =
    await Promise.all([
      getMetals(),
      yahooQuote("BZ=F"),   // Brent Crude, USD/bbl
      yahooQuote("CL=F"),   // WTI Crude, USD/bbl
      yahooQuote("NG=F"),   // Natural Gas, USD/MMBtu
      yahooQuote("CC=F"),   // Cocoa, USD/MT
      yahooQuote("KC=F"),   // Coffee, cents/lb → divide by 100
      yahooQuote("HG=F"),   // Copper, USD/lb
      yahooQuote("CT=F"),   // Cotton, cents/lb → divide by 100
      yahooQuote("SB=F"),   // Sugar No.11, cents/lb → divide by 100
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
      energy: {
        brent_crude: brent,
        wti_crude: wti,
        natural_gas: natgas,
      },
      agricultural: {
        cocoa,
        coffee: coffeeRaw != null ? +(coffeeRaw / 100).toFixed(4) : null,
        cotton: cottonRaw != null ? +(cottonRaw / 100).toFixed(4) : null,
        sugar: sugarRaw != null ? +(sugarRaw / 100).toFixed(4) : null,
      },
      updated: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "public, max-age=900, stale-while-revalidate=300" } }
  );
}
