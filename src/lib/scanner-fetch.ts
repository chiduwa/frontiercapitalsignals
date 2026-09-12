// Hostname checks are defense in depth, not DNS pinning. A controlled egress
// service is still needed to make guarantees about DNS rebinding.
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 3_000_000;
const USER_AGENT = "FCS-AIVisibilityScanner/1.0 (+https://frontiercapitalsignals.com/audit)";

function isUnsafeIpv4(a: number, b: number): boolean {
  if (a >= 224 || a === 127 || a === 10 || a === 0) return true; // loopback / this-network
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

export function isSafeHostname(hostname: string): boolean {
  // WHATWG URL keeps brackets on IPv6 literals (e.g. "[::1]") — strip them
  // before comparing, otherwise every IPv6-literal check below silently no-ops.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".") && !host.includes(":") || host.endsWith(".local") || host.endsWith(".internal")) return false;
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

export async function readBoundedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeds scan size limit");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export function isAllowedScanUrl(url: URL): boolean {
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
    !url.port && isSafeHostname(url.hostname);
}

export async function safeFetch(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  let target = new URL(url);
  if (!isAllowedScanUrl(target)) return { ok: false, text: "", status: 0 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const res = await fetch(target, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
        // Validate every redirect destination before another network request.
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location || redirects === 3) return { ok: false, text: "", status: res.status };
        const next = new URL(location, target);
        if (!isAllowedScanUrl(next)) return { ok: false, text: "", status: res.status };
        target = next;
        continue;
      }
      if (!res.ok || Number(res.headers.get("content-length")) > MAX_BYTES) {
        await res.body?.cancel();
        return { ok: false, text: "", status: res.status };
      }
      const text = await readBoundedText(res.body, MAX_BYTES);
      return { ok: true, text, status: res.status };
    }
    return { ok: false, text: "", status: 0 };
  } catch {
    return { ok: false, text: "", status: 0 };
  } finally {
    clearTimeout(timeout);
  }
}
