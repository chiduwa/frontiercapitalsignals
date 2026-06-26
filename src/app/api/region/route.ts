import { NextResponse } from "next/server";

// EEA member states + Iceland/Liechtenstein/Norway (EEA non-EU) + UK + Switzerland,
// which have GDPR-equivalent consent requirements (UK GDPR, Swiss FADP).
const CONSENT_REQUIRED_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB", "CH",
]);

export async function GET(request: Request) {
  const country = request.headers.get("cf-ipcountry")?.toUpperCase() ?? "";
  // Fail-safe: if the country can't be determined, require consent rather than skip it.
  const requiresConsent = country === "" || country === "XX" || country === "T1"
    ? true
    : CONSENT_REQUIRED_COUNTRIES.has(country);

  return NextResponse.json({ requiresConsent }, { headers: { "Cache-Control": "private, no-store" } });
}
