import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      next: { revalidate: 3600 },
    });
    const data = await res.json();
    if (data.result !== "success") throw new Error("bad response");

    // Return all available rates — client sorts by priority
    return NextResponse.json({
      rates: data.rates as Record<string, number>,
      base: "USD",
      updated: data.time_last_update_utc,
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
