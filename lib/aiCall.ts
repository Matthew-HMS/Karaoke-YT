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

import { llmJSON, type AiAccess } from "./llm";
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
}): Promise<T> {
  const { access, clientId, messages, expect } = opts;

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
  });

  // Only a successful call spends a free use.
  if (access.mode === "free") bumpAiUsage(clientId);
  return out;
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
}): Promise<(T | null)[]> {
  const { access, clientId, batches, expect } = opts;

  if (access.mode === "free" && aiUsageCount(clientId) >= AI_FREE_LIMIT) {
    throw new AiQuotaExceeded();
  }

  const out: (T | null)[] = [];
  let served = 0;
  let lastError: unknown;
  for (const [i, messages] of batches.entries()) {
    try {
      out.push(
        await llmJSON<T>({
          keys: access.keys,
          model: access.model,
          fallback: access.fallback,
          messages,
          expect: expect?.[i],
        })
      );
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

  if (served === 0) throw lastError ?? new Error("no chunk could be fetched");
  if (access.mode === "free") bumpAiUsage(clientId);
  return out;
}
