// Japanese romanization (romaji) for the lyrics view, so singers who can't read
// kana/kanji can still follow along. We only romanise JAPANESE lyrics — detected
// by the presence of kana (hiragana/katakana); kanji-only text is ambiguous
// (could be Chinese) and we deliberately skip it (no Chinese pinyin, by design).
//
// The LLM returns romaji aligned 1:1 with the input lines so the lyrics UI can
// interleave a romaji line under each original line without re-syncing. Results
// are cached in SQLite per videoId, exactly like the lyrics cache, so a song is
// only ever romanised once.

import { aiJSON } from "./aiCall";
import type { AiAccess } from "./llm";
import { getCachedRomaji, putCachedRomaji } from "./db";

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
  opts: { access: AiAccess; clientId: string }
): Promise<string[] | null> {
  if (!lines.some(hasKana)) return null; // not Japanese → nothing to do

  const cached = getCachedRomaji(videoId);
  if (cached && cached.length === lines.length) return cached; // cache hit → free

  const raw = await aiJSON<unknown>({
    access: opts.access,
    clientId: opts.clientId,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(lines) },
    ],
  });
  const romaji = alignRomaji(raw, lines.length);
  putCachedRomaji(videoId, romaji);
  return romaji;
}
