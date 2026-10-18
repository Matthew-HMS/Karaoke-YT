// Quota-aware wrapper around llmJSON. Every AI feature calls the model through
// here so the free-use limit is enforced in ONE place:
//   - "user" / "unlimited" modes: never counted (own key / owner bypass).
//   - "free" mode: capped at AI_FREE_LIMIT calls per identity (account id when
//     signed in, else a per-device guest id). Callers check their cache FIRST,
//     so only genuine model calls (cache misses) ever reach here and count.
// A call that fails does NOT consume quota (we bump only after success), so a
// busy-server 429 never costs the user one of their free uses. Each feature is
// a SINGLE model call per song/prompt, so one free use = one song (don't chunk
// — multiplying calls just burns the daily request cap for no gain). If the
// paid fallback (resolveAccess → access.fallback) serves a "free" call, it still
// counts toward the limit — it's the owner's money, so cap it like any free use.

import { llmJSON, type AiAccess, type ReasoningEffort } from "./llm";
import { aiUsageCount, bumpAiUsage } from "./db";

// How many free AI calls an identity gets on the shared server key.
export const AI_FREE_LIMIT = Number(process.env.AI_FREE_LIMIT) || 5;

// Thrown when a "free" caller has used all AI_FREE_LIMIT calls. Routes turn this
// into a 402 telling the user to paste their own key.
export class AiQuotaExceeded extends Error {
  readonly limit = AI_FREE_LIMIT;
  constructor() {
    super("Free AI limit reached");
    this.name = "AiQuotaExceeded";
  }
}

type Message = { role: "system" | "user" | "assistant"; content: string };

export async function aiJSON<T>(opts: {
  access: AiAccess;
  clientId: string;
  messages: Message[];
  // Lines the reply must cover; a shorter array is retried (see lib/llm.ts).
  expect?: number;
  // Defaults to "none"; raised only by the furigana correction pass.
  reasoningEffort?: ReasoningEffort;
}): Promise<T> {
  const { access, clientId, messages, expect, reasoningEffort } = opts;

  // Enforce the free quota up front (so a blocked call never hits the network).
  if (access.mode === "free" && aiUsageCount(clientId) >= AI_FREE_LIMIT) {
    throw new AiQuotaExceeded();
  }

  const out = await llmJSON<T>({
    keys: access.keys,
    model: access.model,
    fallback: access.fallback,
    messages,
    expect,
    reasoningEffort,
  });

  // Only a successful call spends a free use.
  if (access.mode === "free") bumpAiUsage(clientId);
  return out;
}

// Number each line so the reply can say WHICH line it answers: "0|<line>".
//
// A reply element's position is not trustworthy. The model merges consecutive
// short lines, drops blank ones and occasionally skips one, so the nth element
// is routinely not the nth line — measured on a 43-line song, 42 and 36 element
// replies for 43 and 39 lines. Position alone turns that into every later line
// wearing someone else's text, which for a translation is unnoticeable until
// you read it. An index turns the same mistake into ONE blank line, which
// repairIndexedGaps can then ask for again.
export function numberLines(lines: string[]): string[] {
  return lines.map((line, i) => `${i}|${line}`);
}

const TAGGED_RE = /^\s*(\d{1,4})\s*\|([\s\S]*)$/;

// Map an indexed reply back onto `count` lines. Untagged or out-of-range
// elements are ignored; a line nobody answered for stays "".
export function alignIndexed(raw: unknown, count: number): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out = new Array<string>(count).fill("");
  const seen = new Array<boolean>(count).fill(false);
  let tagged = 0;
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const m = TAGGED_RE.exec(v);
    if (!m) continue;
    const i = Number(m[1]);
    if (i < 0 || i >= count || seen[i]) continue; // first answer for a line wins
    seen[i] = true;
    out[i] = m[2].trim();
    tagged++;
  }
  // The model ignored the protocol entirely → fall back to reading the reply
  // positionally, which is what we did before and still beats showing nothing.
  if (tagged === 0) {
    return Array.from({ length: count }, (_, i) =>
      typeof arr[i] === "string" ? (arr[i] as string).trim() : ""
    );
  }
  return out;
}

// Lines that need asking again: non-blank in the source, but blank in the
// answer. Capped, because if a reply is broken wholesale, re-asking for all of
// it just buys the same failure at twice the latency.
export function indexedGaps(answers: string[], lines: string[], cap: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length && out.length < cap; i++) {
    if (lines[i].trim() && !answers[i]) out.push(i);
  }
  return out;
}

// How many unanswered lines one repair pass will re-ask for. A handful per song
// is normal; if a reply is broken wholesale, re-asking for all of it would just
// buy the same failure at twice the latency.
const MAX_REPAIR_LINES = 24;

// Second chance for the lines nobody answered for — the gaps an indexed reply
// leaves behind when the model merges or skips lines. A short prompt holding
// only the hard lines is an easier job than the whole song, and the model is
// not deterministic even at temperature 0 (the free router spreads requests
// across different underlying models).
//
// Deliberately best-effort: a line is replaced only if the retry actually
// produced text, and any failure keeps what we already had, so a repair can
// never downgrade a result or turn it into an error. It calls llmJSON directly
// rather than aiJSON because the song's ONE free use was already spent on the
// first pass — finishing that same song must not cost a second.
export async function repairIndexedGaps(opts: {
  access: AiAccess;
  system: string;
  answers: string[];
  lines: string[];
}): Promise<string[]> {
  const { access, system, answers, lines } = opts;
  const gaps = indexedGaps(answers, lines, MAX_REPAIR_LINES);
  if (gaps.length === 0) return answers;

  const subset = gaps.map((i) => lines[i]);
  let raw: unknown;
  try {
    raw = await llmJSON<unknown>({
      keys: access.keys,
      model: access.model,
      fallback: access.fallback,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(numberLines(subset)) },
      ],
    });
  } catch {
    return answers; // retry unavailable (rate limit, timeout) → keep what we have
  }

  const retried = alignIndexed(raw, subset.length);
  const out = answers.slice();
  gaps.forEach((lineIndex, k) => {
    if (retried[k]) out[lineIndex] = retried[k];
  });
  return out;
}

// Send the model only the lines it can actually answer for, and put the answers
// back where they came from.
//
// Used by furigana ONLY. A lyric sheet's blank lines (verse breaks) have
// nothing to annotate, and sending them invites the model to reply with fewer
// elements than we sent. Furigana can detect and undo that by matching the
// returned text against the lines, so for it the shorter prompt is a clear win.
// romaji and translation deliberately do NOT use this: they cannot tell a
// merge from a correct answer, and measured on a 43-line song, dropping the
// blanks made the model merge MORE (36 elements for 39 lines, against 42 for
// 43 with the blanks left in). The blanks earn their tokens there.
export function skipBlankLines(lines: string[]) {
  const asked: number[] = [];
  lines.forEach((line, i) => {
    if (line.trim()) asked.push(i);
  });
  return {
    payload: asked.map((i) => lines[i]),
    // `blank` builds what an unanswered line should carry: "" for a string
    // feature, the plain line for furigana's segments.
    restore: <T>(answers: T[], blank: (line: string, i: number) => T): T[] => {
      const full = lines.map(blank);
      asked.forEach((lineIndex, k) => {
        if (answers[k] !== undefined) full[lineIndex] = answers[k];
      });
      return full;
    },
  };
}

// Split an array into fixed-size chunks (used to keep each model call's input
// short enough that the output can't be truncated — see lib/romanize.ts).
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Run several model calls as ONE quota unit, for a song long enough that it must
// be chunked (a single call would exceed the model's output limit and get cut
// off). The free quota is checked once up front and bumped once on overall
// success, so a long song still costs the caller exactly ONE free use — even
// though it's several model calls. Calls run sequentially (gentler on the free
// rate limit).
//
// A failing chunk yields `null` rather than sinking the batch. It used to throw,
// which meant one bad reply threw away the chunks that HAD succeeded and the
// whole song lost its reading — the reason a long song could fail while short
// ones (a single chunk, so a single chance to fail) were fine. Callers coerce a
// null chunk into plain lines for that range. If EVERY chunk fails there is
// nothing to show, so the last error is raised and no quota is spent.
export async function aiJSONBatch<T>(opts: {
  access: AiAccess;
  clientId: string;
  batches: Message[][];
  // Lines each batch must cover, aligned with `batches`.
  expect?: number[];
  // Defaults to "none"; raised only by the furigana correction pass.
  reasoningEffort?: ReasoningEffort;
  // Run the chunks concurrently instead of one after another. Off by default:
  // sequential is gentler on the free tier's per-minute limit, and for the
  // generate paths latency is dominated by output size anyway. The furigana
  // correction pass opts in because it thinks (~6-8s a chunk) while returning
  // almost nothing, so sequential chunks walk straight past the client's ~20s
  // budget — a 74-line song measured 22s sequentially. Concurrent, the whole
  // song costs about what its slowest chunk costs.
  parallel?: boolean;
}): Promise<(T | null)[]> {
  const { access, clientId, batches, expect, reasoningEffort, parallel } = opts;

  if (access.mode === "free" && aiUsageCount(clientId) >= AI_FREE_LIMIT) {
    throw new AiQuotaExceeded();
  }

  const call = (messages: Message[], i: number) =>
    llmJSON<T>({
      keys: access.keys,
      model: access.model,
      fallback: access.fallback,
      messages,
      expect: expect?.[i],
      reasoningEffort,
    });

  const out: (T | null)[] = [];
  let served = 0;
  let lastError: unknown;

  if (parallel) {
    // allSettled keeps the batches in order, which callers rely on to map a
    // chunk back to its lines. Note the one semantic difference from the
    // sequential path: every chunk is already in flight, so a failure cannot
    // stop the others from being spent.
    for (const result of await Promise.all(
      batches.map((messages, i) => call(messages, i).then(
        (value) => ({ ok: true as const, value }),
        (err) => ({ ok: false as const, err })
      ))
    )) {
      if (result.ok) {
        out.push(result.value);
        served++;
      } else {
        if (result.err instanceof AiQuotaExceeded) throw result.err;
        lastError = result.err;
        out.push(null);
      }
    }
  } else {
    for (const [i, messages] of batches.entries()) {
      try {
        out.push(await call(messages, i));
        served++;
      } catch (err) {
        // Quota and key problems apply to every chunk — pressing on would just
        // repeat the same failure and, for a quota error, spend uses we don't
        // have. Only a per-reply failure is worth continuing past.
        if (err instanceof AiQuotaExceeded) throw err;
        lastError = err;
        out.push(null);
      }
    }
  }

  if (served === 0) throw lastError ?? new Error("no chunk could be fetched");
  if (access.mode === "free") bumpAiUsage(clientId);
  return out;
}
