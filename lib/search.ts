// Song search orchestrator: quota-free yt-dlp first, falling back to the
// official YouTube Data API if yt-dlp fails (binary missing, crash, timeout).
// Identical (query, karaokeOnly, limit) results are cached for a while.

import { searchYouTube, type SearchResult } from "./youtube";
import { searchViaYtDlp } from "./ytsearch";

export type SearchSource = "yt-dlp" | "youtube-api" | "cache";

const cache = new Map<string, { at: number; results: SearchResult[] }>();
const TTL_MS = 10 * 60 * 1000;

export async function searchSongs(
  query: string,
  opts: { karaokeOnly: boolean; limit: number }
): Promise<{ results: SearchResult[]; source: SearchSource }> {
  const { karaokeOnly, limit } = opts;
  const key = `${karaokeOnly ? 1 : 0}:${limit}:${query.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { results: hit.results, source: "cache" };
  }

  let results: SearchResult[];
  let source: SearchSource;
  try {
    results = await searchViaYtDlp(query, { karaokeOnly, limit });
    source = "yt-dlp";
  } catch (err) {
    console.warn(
      "[search] yt-dlp failed, falling back to YouTube API:",
      err instanceof Error ? err.message : err
    );
    results = await searchYouTube(query, {
      karaokeOnly,
      limit: Math.min(limit, 50),
    });
    source = "youtube-api";
  }

  cache.set(key, { at: Date.now(), results });
  return { results, source };
}
