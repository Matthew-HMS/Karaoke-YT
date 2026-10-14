// Furigana for the lyrics view: the hiragana reading shown ABOVE each kanji run
// (rendered with HTML <ruby>), like a Japanese songbook. A sibling of
// lib/romanize.ts — same "Japanese only, cached per video" shape — but instead
// of a Latin line underneath, it returns per-line SEGMENTS so the UI can place
// readings only over the kanji and leave kana/punctuation alone.

import type { FuriganaSegment } from "@/lib/types";
import { aiJSON } from "./aiCall";
import type { AiAccess } from "./llm";
import { getCachedFurigana, putCachedFurigana } from "./db";
import { hasKana } from "./romanize";

const SYSTEM = `You annotate Japanese song lyrics with furigana.
Input: a JSON array of lyric lines (strings), in order.
For each line output an array of segments that EXACTLY reconstruct the line in order:
- {"t":"<text>"} for kana / punctuation / spaces / latin (NO reading)
- {"t":"<kanji run>","r":"<hiragana reading>"} for a run of kanji (reading in hiragana)
Rules:
- Only kanji get "r". Never put "r" on kana.
- Concatenating every segment's "t" for a line MUST equal the original line exactly.
- Reply with ONLY a JSON array (same length as input) of these segment arrays. No prose, no code fences.
Example input: ["何十回の夜を過ごした","カラオケ"]
Example output: [[{"t":"何十回","r":"なんじゅっかい"},{"t":"の"},{"t":"夜","r":"よる"},{"t":"を"},{"t":"過","r":"す"},{"t":"ごした"}],[{"t":"カラオケ"}]]`;

// Turn one raw line from the model into clean segments, but ONLY if they
// reconstruct the original line exactly — otherwise fall back to the plain line
// with no furigana, so annotation can never drop or alter a character.
function coerceLine(raw: unknown, original: string): FuriganaSegment[] {
  if (Array.isArray(raw)) {
    const segs: FuriganaSegment[] = [];
    for (const s of raw) {
      if (!s || typeof s !== "object") continue;
      const t = (s as { t?: unknown }).t;
      const r = (s as { r?: unknown }).r;
      if (typeof t !== "string" || t === "") continue;
      segs.push(typeof r === "string" && r ? { t, r } : { t });
    }
    if (segs.map((s) => s.t).join("") === original) return segs;
  }
  return [{ t: original }]; // safe fallback: show the line as-is
}

// Force the model output to exactly `lines.length` validated segment arrays.
export function coerceFurigana(
  raw: unknown,
  lines: string[]
): FuriganaSegment[][] {
  const arr = Array.isArray(raw) ? raw : [];
  return lines.map((line, i) => coerceLine(arr[i], line));
}

// Furigana for a song's lyric lines (one segment array per line), or null when
// the song isn't Japanese so callers can skip rendering. Cached in SQLite.
export async function furiganaLines(
  videoId: string,
  lines: string[],
  opts: { access: AiAccess; clientId: string }
): Promise<FuriganaSegment[][] | null> {
  if (!lines.some(hasKana)) return null; // not Japanese → nothing to do

  const cached = getCachedFurigana(videoId);
  if (cached && cached.length === lines.length) return cached; // cache hit → free

  const raw = await aiJSON<unknown>({
    access: opts.access,
    clientId: opts.clientId,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(lines) },
    ],
  });
  const furigana = coerceFurigana(raw, lines);
  putCachedFurigana(videoId, furigana);
  return furigana;
}
