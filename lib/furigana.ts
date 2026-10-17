// Furigana for the lyrics view: the hiragana reading shown ABOVE each kanji run
// (rendered with HTML <ruby>), like a Japanese songbook. A sibling of
// lib/romanize.ts — same "Japanese only, cached per video" shape — but instead
// of a Latin line underneath, it returns per-line SEGMENTS so the UI can place
// readings only over the kanji and leave kana/punctuation alone.

import type { FuriganaSegment } from "@/lib/types";
import { aiJSON, aiJSONBatch, chunk } from "./aiCall";
import { llmJSON, type AiAccess } from "./llm";
import { getCachedFurigana, putCachedFurigana } from "./db";
import { hasKana } from "./romanize";
import { linesHash, singleFlight } from "./singleflight";

// Lines per model call for long songs. HALF of romaji's 60 (lib/romanize.ts) on
// purpose: furigana's reply is by far the heaviest — a segment object per kanji
// run rather than one string per line — and at 60 the model simply stops early,
// returning a complete, well-formed array of only ~30 entries. Nothing errors,
// so the rest of the chunk silently renders with no readings. Measured on a
// 74-line song: 60-line chunks came back 29-31/60 every attempt (retrying does
// not help — it is not truncation), while 40 and 30 returned the full count on
// every run. 30 leaves headroom.
const CHUNK_LINES = 30;

// How many guard-rejected lines one repair pass will re-ask for. A handful per
// song is normal; if a reply is broken wholesale, re-asking for all of it would
// just buy the same failure at twice the latency.
const MAX_REPAIR_LINES = 24;

const KANJI_RE = /[\u4e00-\u9faf\u3005]/;

// How many times a song's reading may be generated or upgraded before we settle
// for what we have. A few lines occasionally refuse to come back annotated no
// matter how often they're re-asked; without this, serving the cached-but-
// incomplete reading would fire a repair call on every single visit forever.
const MAX_ATTEMPTS = 3;

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

// Lines the reconstruction guard threw away: they contain kanji, so they should
// have gained a reading, but came back as the bare original — which renders as
// plain text with no furigana at all and no error anywhere. Exported for tests.
export function droppedLineIndexes(
  furigana: FuriganaSegment[][],
  lines: string[]
): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    const segs = furigana[i];
    if (!segs || !KANJI_RE.test(line)) return; // kana-only lines are plain by design
    const isBareFallback = segs.length === 1 && segs[0].t === line && !segs[0].r;
    if (isBareFallback) out.push(i);
  });
  return out;
}

// Re-ask for just those lines. Worth a second try because the model is NOT
// deterministic even at temperature 0 (the free router spreads requests across
// different underlying models — measured: three identical requests for one song
// returned 120, 120 and 124 readings), and a short prompt holding only the hard
// lines is an easier alignment problem than the whole song.
//
// Deliberately best-effort: a line is replaced only if the retry actually earned
// it a reading, and any failure keeps the plain text we already had, so a repair
// can never downgrade a result or turn it into an error. It calls llmJSON
// directly rather than aiJSON because the song's ONE free use was already spent
// on the first pass — finishing that same song must not cost a second.
async function repairDroppedLines(
  furigana: FuriganaSegment[][],
  lines: string[],
  access: AiAccess
): Promise<FuriganaSegment[][]> {
  const dropped = droppedLineIndexes(furigana, lines).slice(0, MAX_REPAIR_LINES);
  if (dropped.length === 0) return furigana;

  const subset = dropped.map((i) => lines[i]);
  let raw: unknown;
  try {
    raw = await llmJSON<unknown>({
      keys: access.keys,
      model: access.model,
      fallback: access.fallback,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(subset) },
      ],
      expect: subset.length,
    });
  } catch {
    return furigana; // retry unavailable (rate limit, timeout) → keep plain lines
  }

  const retried = coerceFurigana(raw, subset);
  const out = furigana.slice();
  dropped.forEach((lineIndex, k) => {
    if (retried[k].some((seg) => seg.r)) out[lineIndex] = retried[k];
  });
  return out;
}

// Furigana for a song's lyric lines (one segment array per line), or null when
// the song isn't Japanese so callers can skip rendering. Cached in SQLite.
export async function furiganaLines(
  videoId: string,
  lines: string[],
  opts: { access: AiAccess; clientId: string; refresh?: boolean }
): Promise<FuriganaSegment[][] | null> {
  if (!lines.some(hasKana)) return null; // not Japanese → nothing to do

  const src = linesHash(lines);
  // Collapse the identical requests the TV and every phone fire at once for the
  // same song (and StrictMode's double-invoke in dev) into ONE model call — the
  // cache can't, since it isn't written until the first call finishes.
  return singleFlight(`furigana:${videoId}:${opts.access.model}:${src}:${opts.refresh ? 1 : 0}`, () =>
    annotate(videoId, lines, src, opts)
  );
}

async function annotate(
  videoId: string,
  lines: string[],
  src: string,
  opts: { access: AiAccess; clientId: string; refresh?: boolean }
): Promise<FuriganaSegment[][] | null> {
  // `refresh` forces a fresh annotation (e.g. after switching to a better model),
  // bypassing the cache read; the new result still overwrites the cache.
  if (!opts.refresh) {
    const cached = getCachedFurigana(videoId, src);
    if (cached && cached.segments.length === lines.length) {
      // A cached reading is served immediately even when it still has gaps —
      // re-running the whole song on every visit is what used to burn requests
      // on a song that never completed. If gaps remain and we haven't used up
      // our attempts, upgrade just those lines (a short call) and keep the
      // better result, so the song converges instead of being stuck or costly.
      const gaps = droppedLineIndexes(cached.segments, lines).length;
      if (gaps === 0 || cached.tries >= MAX_ATTEMPTS) return cached.segments;
      const upgraded = await repairDroppedLines(cached.segments, lines, opts.access);
      putCachedFurigana(videoId, upgraded, src, cached.tries + 1);
      return upgraded;
    }
  }

  const prompt = (batch: string[]) => [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: JSON.stringify(batch) },
  ];

  let furigana: FuriganaSegment[][];
  // True when a whole chunk came back unusable, so this reading has a blank
  // range through it. Such a result is worth SHOWING but not worth caching.
  let missingChunk = false;
  if (lines.length <= CHUNK_LINES) {
    // Short song → one call (the common case).
    const raw = await aiJSON<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      messages: prompt(lines),
      expect: lines.length,
    });
    furigana = coerceFurigana(raw, lines);
  } else {
    // Long song → split so no single call's (segment-heavy) output is truncated.
    // Coerce each chunk against its own lines, then concatenate (one free use).
    const batches = chunk(lines, CHUNK_LINES);
    const raws = await aiJSONBatch<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      batches: batches.map(prompt),
      expect: batches.map((b) => b.length),
    });
    missingChunk = raws.some((raw) => raw === null);
    // A null chunk coerces to plain lines for its range, so the chunks that did
    // arrive still reach the singer.
    furigana = raws.flatMap((raw, i) => coerceFurigana(raw, batches[i]));
  }

  // Second chance for the lines the guard dropped, before anything is cached —
  // otherwise a line that silently lost its reading stays that way for good.
  furigana = await repairDroppedLines(furigana, lines, opts.access);

  // ALWAYS cache, gaps and all. Skipping the write for an incomplete reading
  // meant a song that couldn't finish re-ran its whole pipeline on every single
  // visit — the "it calls the API again every time I switch tabs" problem. The
  // gaps are not frozen in: the cache-hit path above upgrades them on a later
  // visit, bounded by MAX_ATTEMPTS. A chunk that went missing entirely starts
  // the count higher, since it has more ground to make up than a stray line.
  putCachedFurigana(videoId, furigana, src, missingChunk ? 1 : MAX_ATTEMPTS - 1);
  return furigana;
}
