// Song search orchestrator: try the quota-free yt-dlp backend first, and only
// if it fails (binary missing, crash, timeout) fall back to the official
// YouTube Data API (which costs 100 quota units/search). Identical queries are
// cached for a while so repeats cost nothing either way.

import { searchYouTube, type SearchResult } from "./youtube";
import { searchViaYtDlp } from "./ytsearch";

export type SearchSource = "yt-dlp" | "youtube-api" | "cache";

const cache = new Map<string, { at: number; results: SearchResult[] }>();
const TTL_MS = 10 * 60 * 1000;

export async function searchSongs(
  query: string,
  karaokeOnly: boolean
): Promise<{ results: SearchResult[]; source: SearchSource }> {
  const key = `${karaokeOnly ? 1 : 0}:${query.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { results: hit.results, source: "cache" };
  }

  let results: SearchResult[];
  let source: SearchSource;
  try {
    results = await searchViaYtDlp(query, karaokeOnly);
    source = "yt-dlp";
  } catch (err) {
    // yt-dlp unavailable/failed — fall back to the official API. This may
    // itself throw (no key / quota exhausted), which the route surfaces.
    console.warn(
      `[search] yt-dlp failed, falling back to YouTube API:`,
      err instanceof Error ? err.message : err
    );
    results = await searchYouTube(query, karaokeOnly);
    source = "youtube-api";
  }

  cache.set(key, { at: Date.now(), results });
  return { results, source };
}
