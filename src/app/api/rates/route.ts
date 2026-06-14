import { NextResponse } from "next/server";

const CURRENCIES = [
  "USD", "EUR", "GBP", "JPY", "CNY", "CHF", "CAD", "AUD",
  "GHS", "NGN", "KES", "MWK", "UGX",
];

export async function GET() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      next: { revalidate: 3600 },
    });
    const data = await res.json();
    if (data.result !== "success") throw new Error("bad response");

    const rates: Record<string, number> = {};
    for (const code of CURRENCIES) {
      if (data.rates[code] != null) rates[code] = data.rates[code];
    }

    return NextResponse.json({ rates, base: "USD", updated: data.time_last_update_utc });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
