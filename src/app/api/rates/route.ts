import { NextResponse } from "next/server";

const ALLOWED_ORIGIN = "https://frontiercapitalsignals.com";

function corsHeaders(origin: string | null) {
  const allowed = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET",
    "Vary": "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function GET(request: Request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: controller.signal });
    const data = await res.json();
    if (data.result !== "success") throw new Error("bad response");

    return NextResponse.json(
      { rates: data.rates as Record<string, number>, base: "USD", updated: data.time_last_update_utc },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=600", ...corsHeaders(request.headers.get("origin")) } }
    );
  } catch {
    return NextResponse.json(
      { error: "unavailable" },
      { status: 503, headers: corsHeaders(request.headers.get("origin")) }
    );
  } finally {
    clearTimeout(timeout);
  }
}
