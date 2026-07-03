// Best-effort detection of the viewer's country, used to bias song discovery
// (search / trending / related / recommendations) toward uploads that are
// actually PLAYABLE where they are. Discovery runs on the server, so without
// this hint every feed reflects the SERVER's region — which is exactly how a
// song gets found + queued but then won't play for someone in another country.
//
// We read it from the browser's language region subtag (e.g. "en-US" → "US"),
// which most browsers carry. Returns "" when there's no usable region, in which
// case the server just falls back to its default behavior.

let cached: string | null = null;

export function detectRegion(): string {
  if (cached !== null) return cached;
  if (typeof navigator === "undefined") return (cached = "");
  const langs =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
  for (const l of langs) {
    const m = /-([A-Za-z]{2})\b/.exec(l || "");
    if (m) return (cached = m[1].toUpperCase());
  }
  return (cached = "");
}

// Sentinels that geo sources emit for "unknown / not a country" (MaxMind leaves
// these on anonymizing proxies; Cloudflare uses XX for unknown, T1 for Tor).
// We treat them as no-region so they don't leak into a YouTube regionCode.
const NON_COUNTRY = new Set(["XX", "ZZ", "AP", "EU", "AA", "QO", "T1"]);

// Normalize/validate a region code coming off a request or header: a 2-letter
// ISO country code, uppercased, or "" if it's missing/malformed/non-country.
// Used server-side so a junk value can't leak into a YouTube API call.
export function normalizeRegion(raw: string | null | undefined): string {
  const r = (raw ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(r) || NON_COUNTRY.has(r)) return "";
  return r;
}

// Resolve the viewer's region for a discovery request. Prefers an edge/proxy
// GeoIP header (IP-accurate — what YouTube actually enforces), set by nginx's
// GeoIP2 module as `X-Country` (also honors common CDN header names). Falls back
// to the client's language-based `?region=` hint when no header is present (dev,
// or before nginx GeoIP is enabled), and to "" when neither is usable.
export function regionFromRequest(req: {
  headers: { get(name: string): string | null };
  nextUrl: { searchParams: URLSearchParams };
}): string {
  const header =
    req.headers.get("x-country") ||
    req.headers.get("cf-ipcountry") ||
    req.headers.get("x-vercel-ip-country") ||
    "";
  const fromHeader = normalizeRegion(header);
  if (fromHeader) return fromHeader;
  return normalizeRegion(req.nextUrl.searchParams.get("region"));
}
