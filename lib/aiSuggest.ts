// Mood / natural-language song search. The user types a vibe ("upbeat mandarin
// party songs", "sad 90s cantonese ballads") and we turn it into real, queueable
// songs. The LLM only ever proposes SEARCH QUERIES (never video ids or urls), so
// a hallucinated title can't create a dead link — every query is resolved through
// the same quota-free search orchestrator the Search tab uses, and only real hits
// come back. Results are cached in-process like lib/search.ts so a repeat prompt
// is instant and barely touches the free-tier rate limit.

import { aiJSON } from "./aiCall";
import type { AiAccess } from "./llm";
import { searchSongs } from "./search";
import type { SearchResult } from "./youtube";

// How many query ideas to ask for, and how many songs we aim to return.
const NUM_QUERIES = 12;

const cache = new Map<string, { at: number; results: SearchResult[] }>();
const TTL_MS = 15 * 60 * 1000;

const SYSTEM = `You are a karaoke DJ for a party app whose crowd mainly sings Mandarin, Cantonese, English and Japanese songs (all eras). Given a mood or request, propose real, well-known, karaoke-friendly songs that match it.

Rules:
- Reply with ONLY a JSON array of strings, no prose, no code fences.
- Each string is a YouTube search query in the form "Artist Title" (romanised or original script both fine).
- Real, famous songs only — never invent titles. Never output video ids or URLs.
- Prefer the language/region the request implies; otherwise mix the four core languages.
- ${NUM_QUERIES} items.`;

// Parse the model's reply (already JSON-extracted by llmJSON) into clean query
// strings: drop non-strings, trim, dedupe, cap length.
export function parseQueries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const q = item.trim().replace(/^["']|["']$/g, "").trim();
    const key = q.toLowerCase();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= NUM_QUERIES) break;
  }
  return out;
}

export async function suggestSongs(
  prompt: string,
  opts: { region?: string; access: AiAccess; clientId: string; exclude?: string[] }
): Promise<SearchResult[]> {
  const { region = "", access, clientId, exclude = [] } = opts;
  const clean = prompt.trim();
  if (!clean) return [];

  // "Load more" passes the titles already shown so the model returns DIFFERENT
  // songs; that makes it part of the cache key (the first page, exclude = [],
  // stays cached and stable).
  const cacheKey = `${region}:${clean.toLowerCase()}:${exclude.length}:${exclude
    .join("|")
    .toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.results;

  const userContent =
    exclude.length > 0
      ? `${clean}\n\nSuggest DIFFERENT songs — do NOT repeat any of these already shown:\n${exclude
          .map((t) => `- ${t}`)
          .join("\n")}`
      : clean;

  const raw = await aiJSON<unknown>({
    access,
    clientId,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userContent },
    ],
  });
  const queries = parseQueries(raw);
  if (queries.length === 0) return [];

  // Resolve each query to its top real result (quota-free yt-dlp first). Run in
  // parallel; a single query failing must not sink the whole set.
  const settled = await Promise.allSettled(
    queries.map((q) =>
      searchSongs(q, { karaokeOnly: false, limit: 1, region })
    )
  );

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const top = s.value.results[0];
    if (top && !seen.has(top.videoId)) {
      seen.add(top.videoId);
      results.push(top);
    }
  }

  cache.set(cacheKey, { at: Date.now(), results });
  return results;
}
