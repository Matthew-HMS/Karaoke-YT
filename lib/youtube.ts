// YouTube Data API v3 helpers. Used only on the server (API routes) so the
// API key never reaches the browser. Set YOUTUBE_API_KEY in .env.local.

export type SearchResult = {
  videoId: string;
  title: string;
  thumbnail: string;
  durationSec: number;
};

const API_BASE = "https://www.googleapis.com/youtube/v3";

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");
  return key;
}

// Pull a video id out of any common YouTube URL shape, or a bare id.
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const m = url.pathname.match(/^\/(embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {
    // not a URL
  }
  return null;
}

// Pull a playlist id (list=...) out of a YouTube URL, if present.
export function extractPlaylistId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.replace(/^www\./, "");
    if (host.endsWith("youtube.com") || host === "youtu.be") {
      const list = url.searchParams.get("list");
      // Ignore auto-generated "radio"/mix lists which aren't real playlists.
      if (list && !/^(RD|UL)/.test(list)) return list;
    }
  } catch {
    // not a URL
  }
  return null;
}

// ISO 8601 duration (e.g. "PT3M20S") → seconds.
export function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, h, min, s] = m;
  return (Number(h) || 0) * 3600 + (Number(min) || 0) * 60 + (Number(s) || 0);
}

function bestThumb(thumbs: Record<string, { url: string }> | undefined): string {
  if (!thumbs) return "";
  return (
    thumbs.medium?.url || thumbs.high?.url || thumbs.default?.url || ""
  );
}

// Fetch duration + canonical metadata for a set of video ids.
async function fetchVideoMeta(ids: string[]): Promise<Map<string, SearchResult>> {
  const out = new Map<string, SearchResult>();
  if (ids.length === 0) return out;
  const url = new URL(`${API_BASE}/videos`);
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", apiKey());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube videos.list failed: ${res.status}`);
  const data = await res.json();
  for (const item of data.items ?? []) {
    out.set(item.id, {
      videoId: item.id,
      title: item.snippet?.title ?? "Untitled",
      thumbnail: bestThumb(item.snippet?.thumbnails),
      durationSec: parseDuration(item.contentDetails?.duration ?? ""),
    });
  }
  return out;
}

export async function getVideoMeta(videoId: string): Promise<SearchResult | null> {
  const map = await fetchVideoMeta([videoId]);
  return map.get(videoId) ?? null;
}

export async function searchYouTube(
  query: string,
  karaokeOnly: boolean
): Promise<SearchResult[]> {
  const q = karaokeOnly ? `${query} karaoke instrumental lyrics` : query;
  const url = new URL(`${API_BASE}/search`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "20");
  url.searchParams.set("q", q);
  if (karaokeOnly) url.searchParams.set("videoCategoryId", "10"); // Music
  url.searchParams.set("videoEmbeddable", "true"); // skip non-embeddable
  url.searchParams.set("key", apiKey());

  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube search.list failed: ${res.status}`);
  const data = await res.json();
  const ids: string[] = (data.items ?? [])
    .map((i: { id?: { videoId?: string } }) => i.id?.videoId)
    .filter(Boolean);

  // search.list lacks durations, so enrich via videos.list (preserves order).
  const meta = await fetchVideoMeta(ids);
  return ids.map((id) => meta.get(id)).filter(Boolean) as SearchResult[];
}
