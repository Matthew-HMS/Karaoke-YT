// Japanese romanization (romaji) for the lyrics view, so singers who can't read
// kana/kanji can still follow along. We only romanise JAPANESE lyrics — detected
// by the presence of kana (hiragana/katakana); kanji-only text is ambiguous
// (could be Chinese) and we deliberately skip it (no Chinese pinyin, by design).
//
// The LLM returns romaji aligned 1:1 with the input lines so the lyrics UI can
// interleave a romaji line under each original line without re-syncing. Results
// are cached in SQLite per videoId, exactly like the lyrics cache, so a song is
// only ever romanised once.

import { aiJSON, aiJSONBatch, chunk } from "./aiCall";
import type { AiAccess } from "./llm";
import { getCachedRomaji, putCachedRomaji } from "./db";

// Lines per model call. The free model reliably returns a correctly-sized array
// up to ~120 lines but drifts/truncates beyond that (its output caps at ~4096
// tokens), which would leave the tail of a long song blank. Longer songs are
// split into chunks this size so every line gets translated. ~60 keeps each
// call's output small and the line count exact, while most songs stay 1 call.
const CHUNK_LINES = 60;

// Hiragana (ぁ-ゟ) or katakana (゠-ヿ, plus half-width ｦ-ﾟ) → Japanese.
const KANA_RE = /[ぁ-ゖ゠-ヿｦ-ﾝ]/;

export function hasKana(text: string): boolean {
  return KANA_RE.test(text);
}

const SYSTEM = `You transliterate Japanese song lyrics into Hepburn romaji.

Rules:
- Input is a JSON array of lyric lines (strings), in order.
- Reply with ONLY a JSON array of the SAME length, no prose, no code fences.
- Output[i] is the Hepburn romaji for input[i].
- Preserve line order and count exactly. An empty or non-Japanese line maps to "".
- Romaji only in the output — no kana, no kanji.`;

// Force the LLM output back into an array the same length as `lines`, so the UI's
// index-based interleaving never drifts. Missing entries become "".
export function alignRomaji(raw: unknown, count: number): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const v = arr[i];
    out.push(typeof v === "string" ? v.trim() : "");
  }
  return out;
}

// Romanise a song's lyric lines (returns one romaji string per input line, or
// null when the song isn't Japanese so callers can skip rendering). `key` is the
// resolved AI access (key pool + model). Cached in SQLite per videoId.
export async function romanizeLines(
  videoId: string,
  lines: string[],
  opts: { access: AiAccess; clientId: string; refresh?: boolean }
): Promise<string[] | null> {
  if (!lines.some(hasKana)) return null; // not Japanese → nothing to do

  // `refresh` forces a fresh translation (e.g. after switching to a better
  // model), bypassing the cache read; the new result still overwrites the cache.
  if (!opts.refresh) {
    const cached = getCachedRomaji(videoId);
    if (cached && cached.length === lines.length) return cached; // cache hit → free
  }

  const prompt = (batch: string[]) => [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: JSON.stringify(batch) },
  ];

  let romaji: string[];
  if (lines.length <= CHUNK_LINES) {
    // Short song → one call (the common case).
    const raw = await aiJSON<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      messages: prompt(lines),
    });
    romaji = alignRomaji(raw, lines.length);
  } else {
    // Long song → split so no single call's output is truncated. Align each
    // chunk to its own length, then concatenate (counts a single free use).
    const batches = chunk(lines, CHUNK_LINES);
    const raws = await aiJSONBatch<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      batches: batches.map(prompt),
    });
    romaji = raws.flatMap((raw, i) => alignRomaji(raw, batches[i].length));
  }

  putCachedRomaji(videoId, romaji);
  return romaji;
}
