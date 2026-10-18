// Japanese romanization (romaji) for the lyrics view, so singers who can't read
// kana/kanji can still follow along. We only romanise JAPANESE lyrics — detected
// by the presence of kana (hiragana/katakana); kanji-only text is ambiguous
// (could be Chinese) and we deliberately skip it (no Chinese pinyin, by design).
//
// The LLM returns romaji aligned 1:1 with the input lines so the lyrics UI can
// interleave a romaji line under each original line without re-syncing. Results
// are cached in SQLite per videoId, exactly like the lyrics cache, so a song is
// only ever romanised once.

import {
  aiJSON,
  aiJSONBatch,
  chunk,
  numberLines,
  alignIndexed,
  repairIndexedGaps,
} from "./aiCall";
import { linesHash, singleFlight } from "./singleflight";
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
- Input is a JSON array of lyric lines, each written "<n>|<lyric>".
- Reply with ONLY a JSON array of strings, each written "<n>|<romaji>", no prose, no code fences.
- Reuse the SAME <n> as the line you transliterated. One entry per input line, in order.
- Never merge two input lines into one entry and never split one into two — if two lines read as one sentence, still answer them separately.
- An empty or non-Japanese line maps to "<n>|".
- Romaji only in the output — no kana, no kanji.`;

// Force the LLM output back into an array the same length as `lines`, so the
// UI's index-based interleaving never drifts. Each reply entry says which line
// it answers (see numberLines); an untagged reply is read positionally, as
// before. Lines nobody answered for become "" and are re-asked once.
export function alignRomaji(raw: unknown, count: number): string[] {
  return alignIndexed(raw, count);
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

  const src = linesHash(lines);
  // One model call per song even when every device in the room asks at once —
  // see lib/singleflight.ts.
  return singleFlight(`romaji:${videoId}:${opts.access.model}:${src}:${opts.refresh ? 1 : 0}`, () =>
    romanize(videoId, lines, src, opts)
  );
}

async function romanize(
  videoId: string,
  lines: string[],
  src: string,
  opts: { access: AiAccess; clientId: string; refresh?: boolean }
): Promise<string[] | null> {
  // `refresh` forces a fresh translation (e.g. after switching to a better
  // model), bypassing the cache read; the new result still overwrites the cache.
  if (!opts.refresh) {
    const cached = getCachedRomaji(videoId, src);
    if (cached && cached.length === lines.length) return cached; // cache hit → free
  }

  const prompt = (batch: string[]) => [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: JSON.stringify(numberLines(batch)) },
  ];

  // NOTE: blank lines are deliberately sent here, unlike furigana. They cost a
  // few tokens but keep the model's line discipline: measured on a 43-line song,
  // sending all 43 came back 42 long, while sending only the 39 filled lines
  // came back 36 — it ran four consecutive spoken-word lines together. Furigana
  // can detect and undo a merge by matching text; a translation can't, so the
  // cheapest defence is not to provoke it. Indexing (below) catches the rest.
  let romaji: string[];
  if (lines.length <= CHUNK_LINES) {
    // Short song → one call (the common case).
    const raw = await aiJSON<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      messages: prompt(lines),
      expect: lines.length,
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
      expect: batches.map((b) => b.length),
    });
    romaji = raws.flatMap((raw, i) => alignRomaji(raw, batches[i].length));
  }

  // Second chance for the lines the reply skipped, before anything is cached —
  // a cache hit never re-calls, so a gap left here is a gap for good.
  romaji = await repairIndexedGaps({
    access: opts.access,
    system: SYSTEM,
    answers: romaji,
    lines,
  });

  // Cached even if a chunk came back empty. Not caching it meant the whole
  // song re-ran on every visit, which costs far more than the blank range is
  // worth. Anything the repair pass above could not fill stays blank; ↻ Refresh
  // with AI (which bypasses the cache) is the way to re-roll it.
  putCachedRomaji(videoId, romaji, src);
  return romaji;
}
