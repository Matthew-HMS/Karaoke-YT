// Furigana for the lyrics view: the hiragana reading shown ABOVE each kanji run
// (rendered with HTML <ruby>), like a Japanese songbook. A sibling of
// lib/romanize.ts — same "Japanese only, cached per video" shape — but instead
// of a Latin line underneath, it returns per-line SEGMENTS so the UI can place
// readings only over the kanji and leave kana/punctuation alone.

import type { FuriganaSegment } from "@/lib/types";
import { aiJSON, aiJSONBatch, chunk, skipBlankLines } from "./aiCall";
import { llmJSON, type AiAccess, type ReasoningEffort } from "./llm";
import { getCachedFurigana, putCachedFurigana } from "./db";
import { furiganaLinesLocal } from "./furiganaLocal";
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
- Output EXACTLY one segment array per input line, in the same order. Never merge two lines into one, never split one line into two, never skip a line.
- Reply with ONLY a JSON array (same length as input) of these segment arrays. No prose, no code fences.
Example input: ["何十回の夜を過ごした","カラオケ"]
Example output: [[{"t":"何十回","r":"なんじゅっかい"},{"t":"の"},{"t":"夜","r":"よる"},{"t":"を"},{"t":"過","r":"す"},{"t":"ごした"}],[{"t":"カラオケ"}]]`;

// How many lyric lines one returned element may have swallowed. The model
// sometimes glues consecutive short lines into a single segment array — on one
// 43-line song "君が僕に見せてくれた" + "世界はとても綺麗だったな" came back as
// element 0 — which, read positionally, shifted every line after it onto the
// wrong reading.
const MAX_MERGE_LINES = 3;

// How far to look when an element fits neither this line nor a merge of the
// next few. The model may have skipped a line, or emitted one we can't use;
// resyncing within a few steps costs ONE line either way instead of every line
// after it.
const RESYNC_WINDOW = 3;

const SPACE_RE = /\s/;
const nonSpace = (s: string) => s.replace(/\s+/g, "");

// Pull well-formed segments out of one raw element: text must be a non-empty
// string, a reading only counts if it's a non-empty string. Shape only — which
// LINE they belong to is decided by coerceFurigana.
function cleanSegments(raw: unknown): FuriganaSegment[] {
  if (!Array.isArray(raw)) return [];
  const segs: FuriganaSegment[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const t = (s as { t?: unknown }).t;
    const r = (s as { r?: unknown }).r;
    if (typeof t !== "string" || t === "") continue;
    segs.push(typeof r === "string" && r ? { t, r } : { t });
  }
  return segs;
}

// Index in `t` just past its `n`th non-space character.
function cutAfter(t: string, n: number): number {
  let seen = 0;
  for (let i = 0; i < t.length; i++) {
    if (!SPACE_RE.test(t[i])) seen++;
    if (seen === n) return i + 1;
  }
  return t.length;
}

// Rebuild `segs` so their text concatenates to `line` EXACTLY, taking the
// spacing from the line and only the readings from the model. The model likes
// to normalise a space away ("君だ 君なんだ」" came back as "君だ君なんだ」"),
// and under a character-exact guard that threw away an otherwise perfect
// reading. Whitespace is attached OUTSIDE a kanji run — a space inside a ruby
// base would misdraw the annotation, so that case gives up and the caller keeps
// the plain line.
function respace(
  segs: FuriganaSegment[],
  line: string
): FuriganaSegment[] | null {
  if (segs.map((s) => s.t).join("") === line) return segs; // already exact

  const out: FuriganaSegment[] = [];
  const addPlain = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    // Merge with the previous plain run so we don't emit adjacent <span>s.
    if (last && !last.r) out[out.length - 1] = { t: last.t + t };
    else out.push({ t });
  };

  let i = 0;
  for (const seg of segs) {
    let need = nonSpace(seg.t).length;
    if (need === 0) continue; // a whitespace-only segment carries nothing
    let lead = "";
    while (i < line.length && SPACE_RE.test(line[i])) lead += line[i++];
    addPlain(lead);
    let taken = "";
    while (i < line.length && need > 0) {
      const ch = line[i++];
      taken += ch;
      if (!SPACE_RE.test(ch)) need--;
    }
    if (need > 0) return null; // the line ran out mid-segment
    if (seg.r) {
      if (nonSpace(taken) !== taken) return null; // space under a ruby base
      out.push({ t: taken, r: seg.r });
    } else addPlain(taken);
  }
  addPlain(line.slice(i)); // trailing punctuation / whitespace
  return out.map((s) => s.t).join("") === line ? out : null;
}

// Hand `segs` out to `targets` in order, by how many non-space characters each
// target needs. Returns null rather than guessing when the split would fall
// inside a kanji run (one reading covers the whole run, so it can't be halved)
// or when the segments don't cover the targets.
function splitSegments(
  segs: FuriganaSegment[],
  targets: string[]
): FuriganaSegment[][] | null {
  const groups: FuriganaSegment[][] = [];
  let next = 0;
  let carry: FuriganaSegment | null = null;
  for (const target of targets) {
    let need = nonSpace(target).length;
    const group: FuriganaSegment[] = [];
    while (need > 0) {
      const seg: FuriganaSegment | undefined = carry ?? segs[next++];
      if (!seg) return null; // ran out of segments
      carry = null;
      const have = nonSpace(seg.t).length;
      if (have <= need) {
        group.push(seg);
        need -= have;
        continue;
      }
      if (seg.r) return null; // can't split a reading
      const cut = cutAfter(seg.t, need);
      group.push({ t: seg.t.slice(0, cut) });
      carry = { t: seg.t.slice(cut) };
      need = 0;
    }
    groups.push(group);
  }
  // Leftover segments mean the element covered MORE than these targets.
  const left = (carry?.t ?? "") + segs.slice(next).map((s) => s.t).join("");
  return nonSpace(left) ? null : groups;
}

// Try to read `segs` as the annotation for exactly `targets` — one line, or the
// few the model merged into one element. All or nothing: either every target
// reconstructs exactly, or null and the caller keeps plain text.
function fitSpan(
  segs: FuriganaSegment[],
  targets: string[]
): FuriganaSegment[][] | null {
  const text = nonSpace(segs.map((s) => s.t).join(""));
  if (text !== nonSpace(targets.join(""))) return null;
  const groups = splitSegments(segs, targets);
  if (!groups) return null;
  const out: FuriganaSegment[][] = [];
  for (const [i, target] of targets.entries()) {
    const fitted = respace(groups[i], target);
    if (!fitted) return null;
    out.push(fitted);
  }
  return out;
}

// Map the model's reply onto the lyric lines and return exactly one segment
// array per line.
//
// Alignment is by CONTENT, not by array position. Position looks obvious and is
// wrong: the model merges short lines, drops blank ones and occasionally skips
// one, so element k routinely belongs to some other line. Positionally that put
// line 4's reading over line 3 — which the reconstruction guard then rightly
// refused, line after line, leaving a whole chunk plain. Matching on text
// instead means a line is annotated when its OWN reading came back, wherever in
// the reply it landed, and a stray element costs one line rather than all of
// the rest.
export function coerceFurigana(
  raw: unknown,
  lines: string[]
): FuriganaSegment[][] {
  const elements = (Array.isArray(raw) ? raw : []).map(cleanSegments);
  // Default: the plain line. Anything we can't place with certainty stays this
  // way, so annotation can never drop, alter or mis-place a character.
  const out: FuriganaSegment[][] = lines.map((line) => [{ t: line }]);

  let el = 0;
  let li = 0;
  while (li < lines.length && el < elements.length) {
    if (!lines[li].trim()) {
      li++; // blank line: nothing to read, and it needs no element
      continue;
    }
    const segs = elements[el];
    if (!nonSpace(segs.map((s) => s.t).join(""))) {
      el++; // empty element (often the model's answer for a blank line)
      continue;
    }

    const one = fitSpan(segs, [lines[li]]);
    if (one) {
      out[li] = one[0];
      li++;
      el++;
      continue;
    }

    // This element may have swallowed the next line or two.
    let merged: FuriganaSegment[][] | null = null;
    let span = 0;
    for (let k = 2; k <= MAX_MERGE_LINES && li + k <= lines.length; k++) {
      merged = fitSpan(segs, lines.slice(li, li + k));
      if (merged) {
        span = k;
        break;
      }
    }
    if (merged) {
      merged.forEach((segsForLine, k) => {
        if (segsForLine.length) out[li + k] = segsForLine;
      });
      li += span;
      el++;
      continue;
    }

    // Fits neither. Either a later element belongs to this line (this one is
    // unusable), or this element belongs to a later line (a line's reading went
    // missing). Take whichever is nearer, so we lose one line, not the chunk.
    const elHit = elements.findIndex(
      (cand, i) => i > el && i <= el + RESYNC_WINDOW && !!fitSpan(cand, [lines[li]])
    );
    const liHit = lines.findIndex(
      (cand, i) => i > li && i <= li + RESYNC_WINDOW && !!fitSpan(segs, [cand])
    );
    if (elHit !== -1 && (liHit === -1 || elHit - el <= liHit - li)) {
      el = elHit;
      continue;
    }
    if (liHit !== -1) {
      li = liHit;
      continue;
    }
    li++; // nothing fits: keep the plain line and move both on
    el++;
  }
  return out;
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
      // Same reasoning as the first pass: whatever comes back is aligned by
      // content, so a short reply fills the lines it covers instead of costing
      // two more calls. Lines still missing are picked up on a later visit,
      // bounded by MAX_ATTEMPTS.
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

// ---------------------------------------------------------------------------
// ↻ Re-generate: ask the model to CORRECT the dictionary reading, not to
// replace it.
//
// Regenerating from scratch threw away a reading that was ~99.9% right and
// re-ran every failure mode the model has: dropped lines, truncated replies,
// run-to-run non-determinism. Reviewing is a far easier job than generating —
// the model only has to spot the handful of readings a dictionary gets wrong in
// context (愛おしい, 他の, 一人) — and because it returns ONLY the lines it is
// changing, the reply is a few hundred tokens instead of a few thousand, which
// is what made long songs truncate in the first place.
//
// The dictionary result is the floor: every correction must reconstruct its
// line exactly AND annotate at least as many kanji as the dictionary already
// did, so a re-generate can raise quality but never lower coverage.
// ---------------------------------------------------------------------------

const REVISE_SYSTEM = `You proofread Japanese furigana produced by the IPADIC morphological dictionary.
Input: a JSON array of {"i":<line index>,"line":"<original line>","reading":"<the line with each kanji run's current reading in parentheses>"}.

Check EVERY kanji run. The dictionary is right most of the time, but it fails in four specific ways, and these are what you are looking for:
1. RENDAKU (連濁): it reads a compound as separate words, so the second element stays unvoiced. 山桜 as やま+さくら instead of やまざくら; 風車 as かぜ+くるま instead of かざぐるま. Whenever two kanji words sit together as one compound, ask whether the second one voices.
2. ON/KUN picked from the wrong context: a kanji that takes its kun reading alone but an on reading in a compound, or the reverse. 人 as じん inside a word but ひと alone; 日 as にち vs ひ.
3. Counters and set phrases read literally: 一人 as いちにん rather than ひとり.
4. A kanji run left with NO reading at all — give it one.

Reply with ONLY a JSON array of the lines you are changing:
[{"i":<index>,"segs":[{"t":"<text>"},{"t":"<kanji run>","r":"<hiragana reading>"}]}]
Rules:
- Return ONLY changed lines. Reply [] only when you have checked every run and every one is right — [] is a claim that the whole input is correct, so do not use it to skip the work.
- Concatenating a line's segment "t" values MUST equal that line's "line" exactly.
- Only kanji get "r", written in hiragana. Never put "r" on kana.
- Never drop a reading that is already present — only fix it or add a missing one.
- You may regroup segments: if the dictionary split a compound, return it as one run with the compound reading.
- No prose, no code fences.`;

// Lines per correction call. Chunking here is driven by the INPUT, not the
// reply (which holds only the changed lines): the longer the list handed over,
// the more the model skims it. Measured on a 74-line song, same model and
// prompt, chunks running concurrently — 120 lines in one chunk: 17.4s and 0
// corrections; 60: 12-20s and 0-1; 25: 12-13s and 1-2, both genuine (1人 read
// as にん, 観 as かん). Smaller is faster AND finds more, because the chunks
// overlap: the song costs about what its slowest chunk costs, not their sum.
const REVISE_CHUNK_LINES = 25;

// Per-song cap on the correction detail written to the log, so one bad reply
// cannot bury the rest of the output.
const LOG_LIMIT = 12;

const HIRAGANA_ONLY = /^[぀-ゟー]+$/;
const KANA_RE = /[぀-ゟ゠-ヿ]/;

// A run may carry a reading when it holds kanji and NO kana. "Pure kanji" was
// too strict: the model correctly proposed 1人 → ひとり and the half-width
// digit got the whole line thrown out. What must never happen is ruby drawn
// over kana (を掻き消すような) — the annotation then covers text that is
// already readable, and lands in the wrong place.
const canCarryReading = (t: string) => KANJI_RE.test(t) && !KANA_RE.test(t);

// Reject a "correction" that just swallowed the kana sitting in front of the
// run: the model returned 一日中(はいちにちじゅう) for 今日は一日中雨 — the
// dictionary's いちにちじゅう with the preceding は glued on. It reconstructs,
// it is all-kanji, it keeps coverage, and it is still wrong, so the shape of
// the mistake is what identifies it: the new reading ENDS with the old one and
// the extra head is exactly the text just before the run.
function swallowedNeighbour(
  before: string,
  run: string,
  reading: string,
  base: FuriganaSegment[]
): boolean {
  const old = base.find((s) => s.t === run && s.r)?.r;
  if (!old || reading === old || !reading.endsWith(old)) return false;
  const extra = reading.slice(0, reading.length - old.length);
  return before.endsWith(extra);
}

// "君(きみ)が僕(ぼく)に見(み)せてくれた" — compact enough to send a whole song,
// and the model reads it without having to parse segment objects.
function renderReading(segs: FuriganaSegment[]): string {
  return segs.map((s) => (s.r ? `${s.t}(${s.r})` : s.t)).join("");
}

function annotatedKanji(segs: FuriganaSegment[]): number {
  let n = 0;
  for (const s of segs) {
    if (!s.r) continue;
    for (const ch of s.t) if (KANJI_RE.test(ch)) n++;
  }
  return n;
}

// What the correction pass did, so a recurring fix can be promoted into
// furiganaLocal's OVERRIDES — where it becomes free and deterministic — and so
// a model that is proposing nonsense is visible rather than silently filtered.
export type RevisionLog = {
  applied: { line: number; run: string; from: string; to: string }[];
  rejected: { line: number; run: string; to: string; why: string }[];
};

// Readings that differ between two segmentations of the same line, keyed by
// position so the same kanji twice in a line stays distinct.
function readingChanges(
  before: FuriganaSegment[],
  after: FuriganaSegment[]
): { run: string; from: string; to: string }[] {
  const at = (segs: FuriganaSegment[]) => {
    const m = new Map<string, { run: string; reading: string }>();
    let off = 0;
    for (const s of segs) {
      if (s.r) m.set(`${off}:${s.t}`, { run: s.t, reading: s.r });
      off += s.t.length;
    }
    return m;
  };
  const a = at(before);
  const out: { run: string; from: string; to: string }[] = [];
  for (const [key, got] of at(after)) {
    const had = a.get(key);
    if (!had) out.push({ run: got.run, from: "", to: got.reading });
    else if (had.reading !== got.reading) out.push({ run: got.run, from: had.reading, to: got.reading });
  }
  return out;
}

// Merge the model's corrections onto the dictionary reading. Every correction
// is checked independently and silently dropped if it fails, so a bad reply
// degrades to the dictionary result rather than corrupting it. Exported for tests.
export function applyRevisions(
  base: FuriganaSegment[][],
  lines: string[],
  raw: unknown,
  log?: RevisionLog
): FuriganaSegment[][] {
  if (!Array.isArray(raw)) return base;
  const out = base.slice();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const i = (item as { i?: unknown }).i;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= lines.length) continue;

    const segs = cleanSegments((item as { segs?: unknown }).segs);
    if (segs.length === 0) continue;

    // Must reconstruct the line exactly (respace tolerates only whitespace drift).
    const raw2 = respace(segs, lines[i]);
    if (!raw2) {
      log?.rejected.push({ line: i, run: lines[i], to: "", why: "does not reconstruct the line" });
      continue;
    }

    // Readings are checked one run at a time, and a bad one falls back to the
    // dictionary's own reading for that run instead of condemning the line: the
    // model bundles good and bad corrections into the same reply, and throwing
    // the line away loses the good one too. Measured on one line, the model
    // returned a correct 雨(あめ) next to a wrong 一日中(はいちにちじゅう).
    const placed = raw2.map((s, idx) => {
      if (!s.r) return s;
      const before = raw2.slice(0, idx).map((x) => x.t).join("");
      const why = !HIRAGANA_ONLY.test(s.r)
        ? "reading is not kana"
        : !canCarryReading(s.t)
          ? "reading sits on a run containing kana"
          : swallowedNeighbour(before, s.t, s.r, out[i])
            ? "reading swallowed the kana in front of it"
            : null;
      if (!why) return s;
      log?.rejected.push({ line: i, run: s.t, to: s.r, why });
      const fromDictionary = out[i].find((x) => x.t === s.t && x.r)?.r;
      return fromDictionary ? { t: s.t, r: fromDictionary } : { t: s.t };
    });

    // The invariant that makes this safe: a correction may raise coverage or
    // leave it alone, never reduce it.
    if (annotatedKanji(placed) < annotatedKanji(out[i])) {
      log?.rejected.push({
        line: i,
        run: lines[i],
        to: renderReading(placed),
        why: "would annotate fewer kanji than the dictionary did",
      });
      continue;
    }

    // Sanitising can leave adjacent bare runs; respace merges them back into
    // one plain segment so the line renders as few spans as possible.
    const merged = respace(placed, lines[i]) ?? placed;
    if (log) for (const change of readingChanges(out[i], merged)) log.applied.push({ line: i, ...change });
    out[i] = merged;
  }
  return out;
}

async function reviseFurigana(
  videoId: string,
  base: FuriganaSegment[][],
  lines: string[],
  opts: { access: AiAccess; clientId: string }
): Promise<FuriganaSegment[][]> {
  // Only lines that can carry a reading are worth a correction pass.
  const candidates: { i: number; line: string; reading: string }[] = [];
  lines.forEach((line, i) => {
    if (KANJI_RE.test(line)) candidates.push({ i, line, reading: renderReading(base[i]) });
  });
  if (candidates.length === 0) return base;

  // Indices travel with each item, so chunks need no offset bookkeeping.
  const batches = chunk(candidates, REVISE_CHUNK_LINES);
  const messages = batches.map((batch) => [
    { role: "system" as const, content: REVISE_SYSTEM },
    { role: "user" as const, content: JSON.stringify(batch) },
  ]);

  // Every other call here is mechanical and runs at reasoning_effort "none".
  // Proofreading is not: measured over five live runs at "none", the model
  // changed nothing four times and once returned two correct fixes alongside
  // two malformed ones. So this one call thinks — but only on a paid model,
  // because the free tier rejects any effort above "none" with a 402.
  //
  // Thinking costs ~6-8s a chunk, so the chunks go out CONCURRENTLY (`parallel`
  // below): sequentially a 74-line song took 22s, past the client's ~20s
  // budget. Sending it as one larger chunk was faster but the model skimmed it
  // and found nothing, so the answer is more chunks at once, not bigger ones.
  const effort: ReasoningEffort = opts.access.model.includes("free")
    ? "none"
    : (process.env.FURIGANA_REVISE_EFFORT as ReasoningEffort) || "low";

  let raws: (unknown | null)[];
  try {
    raws = await aiJSONBatch<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      batches: messages,
      reasoningEffort: effort,
      parallel: true,
    });
  } catch (e) {
    if (effort === "none") throw e;
    // An upstream that refuses the raised effort must not cost the singer their
    // ↻; fall back to the setting every other call uses.
    console.warn(`[furigana] revise at effort="${effort}" failed, retrying with none:`, e);
    raws = await aiJSONBatch<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      batches: messages,
      parallel: true,
    });
  }

  const log: RevisionLog = { applied: [], rejected: [] };
  let out = base;
  for (const raw of raws) if (raw !== null) out = applyRevisions(out, lines, raw, log);

  // One line per song, then the detail. The applied list is the useful one:
  // a reading that keeps coming back belongs in furiganaLocal's OVERRIDES,
  // where it costs nothing and cannot regress. The rejected list is how you
  // notice the model drifting into malformed replies.
  console.log(
    `[furigana] revise ${videoId} model=${opts.access.model} effort=${effort} ` +
      `applied=${log.applied.length} rejected=${log.rejected.length}`
  );
  for (const a of log.applied.slice(0, LOG_LIMIT)) {
    console.log(`[furigana]   L${a.line} ${a.run}: ${a.from || "(none)"} -> ${a.to}`);
  }
  for (const r of log.rejected.slice(0, LOG_LIMIT)) {
    console.warn(`[furigana]   L${r.line} ${r.run} refused (${r.why})${r.to ? `: ${r.to}` : ""}`);
  }
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

  // DICTIONARY FIRST, for both paths. kuromoji annotates ~99.9% of kanji
  // offline in ~33ms with no key, no quota and no network, and its
  // reconstruction guard did not trip once over the whole local library. A
  // normal visit stops there; ↻ re-generate hands that result to the model as a
  // CORRECTION task (reviseFurigana) rather than asking for the song again, so
  // the model can only improve on the dictionary, never undercut its coverage.
  // Set FURIGANA_ENGINE=llm to put the model back in front.
  let baseline: FuriganaSegment[][] | null = null;
  if (process.env.FURIGANA_ENGINE !== "llm") {
    try {
      baseline = await furiganaLinesLocal(lines);
      const gaps = droppedLineIndexes(baseline, lines).length;
      const kanjiLines = lines.filter((l) => KANJI_RE.test(l)).length;
      // Give up on the dictionary only if it essentially failed on this song
      // (an unusual script, heavy ateji) — then the model is the better bet.
      if (gaps * 2 > kanjiLines) {
        console.warn(`[furigana] dictionary left ${gaps}/${kanjiLines} lines bare, asking the model`);
        baseline = null;
      }
    } catch (e) {
      // A missing or unreadable dictionary must not take readings down with it.
      console.warn("[furigana] dictionary unavailable, falling back to the model:", e);
      baseline = null;
    }
  }

  if (baseline && !opts.refresh) {
    // Stored one short of the cap, like a fresh model reading, so a later visit
    // may spend ONE repair call on whatever came back bare.
    putCachedFurigana(videoId, baseline, src, MAX_ATTEMPTS - 1);
    return baseline;
  }

  if (baseline) {
    // ↻ re-generate. A failure here propagates: the singer asked for the model,
    // and the reading already on screen is this same baseline, so the UI's
    // "AI unavailable, retry" note loses them nothing. The previously cached
    // row is left intact for the next ordinary visit.
    const revised = await reviseFurigana(videoId, baseline, lines, opts);
    // At the cap: the model has now had its look, so later visits shouldn't
    // spend another call chasing the few runs it chose to leave bare.
    putCachedFurigana(videoId, revised, src, MAX_ATTEMPTS);
    return revised;
  }

  const prompt = (batch: string[]) => [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: JSON.stringify(batch) },
  ];

  // Only the lines that can carry a reading are sent (see skipBlankLines). The
  // aligner below copes with a dropped blank line, but not sending blanks at all
  // removes the commonest cause outright and shortens every prompt.
  const { payload, restore } = skipBlankLines(lines);
  const expand = (annotated: FuriganaSegment[][]) =>
    restore(annotated, (line) => [{ t: line }]);

  let furigana: FuriganaSegment[][];
  // True when a whole chunk came back unusable, so this reading has a blank
  // range through it. Such a result is worth SHOWING but not worth caching.
  let missingChunk = false;
  if (payload.length <= CHUNK_LINES) {
    // Short song → one call (the common case).
    const raw = await aiJSON<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      messages: prompt(payload),
      // No `expect` here, unlike romaji/translate. A short reply used to be
      // retried because a missing element silently blanked every line after it;
      // coerceFurigana aligns by content now, so a short reply still annotates
      // the lines it DID cover and repairDroppedLines asks for just the rest —
      // one short call instead of two full re-asks. (An unreadable reply is
      // still retried: lib/llm.ts handles that separately.) Measured on the
      // 43-line song this was found on, both reaching 39 of 39 annotated lines:
      // 5 requests / 24.5s with `expect`, 3 requests / 13.5s without.
    });
    furigana = expand(coerceFurigana(raw, payload));
  } else {
    // Long song → split so no single call's (segment-heavy) output is truncated.
    // Coerce each chunk against its own lines, then concatenate (one free use).
    const batches = chunk(payload, CHUNK_LINES);
    const raws = await aiJSONBatch<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      batches: batches.map(prompt),
      // See the single-chunk call above for why no `expect`.
    });
    missingChunk = raws.some((raw) => raw === null);
    // A null chunk coerces to plain lines for its range, so the chunks that did
    // arrive still reach the singer.
    furigana = expand(raws.flatMap((raw, i) => coerceFurigana(raw, batches[i])));
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
