import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();
    if (data.result !== "success") throw new Error("bad response");

    return NextResponse.json(
      {
        rates: data.rates as Record<string, number>,
        base: "USD",
        updated: data.time_last_update_utc,
      },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=600" } }
    );
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
