// OrcaRouter client (server-only). OrcaRouter is an OpenAI-compatible gateway
// (https://api.orcarouter.ai/v1) the project accesses through its OSS-program
// key. We always use a FREE model (`orcarouter/free`, difficulty-routed across
// the workspace's free models, billed at nothing, capped by request rate), so
// AI features never cost anything — a rate-limited request just degrades.
//
// KEY SAFETY: the server default key (ORCAROUTER_API_KEY) is read only here and
// MUST NEVER be sent to the browser. A request may carry the *user's own* key
// (the `x-orca-key` header); when present it takes precedence over the default.
// `resolveKey` centralises that precedence so no route leaks the default.
//
// Wired with plain fetch (no SDK) to match the rest of lib/.

const API_BASE =
  process.env.ORCAROUTER_API_BASE_URL || "https://api.orcarouter.ai/v1";

// Free, difficulty-routed model. Override only if you know the id you want.
const MODEL = process.env.ORCAROUTER_MODEL || "orcarouter/free";

// The PAID fallback model (used only when the free pool can't serve — see
// `paidFallback`). A fixed, cheap, non-reasoning model is the right pick: our
// tasks are mechanical, so difficulty-routing (`orcarouter-auto`) would only add
// cost/latency variance for no quality gain. ~$0.0002/song, same fast family.
const PAID_MODEL = process.env.ORCAROUTER_PAID_MODEL || "deepseek/deepseek-v4-flash";

// Cap each call so a slow/hung upstream can't stall the request behind it. With
// reasoning disabled a full song romanizes in ~4s on a fast model; 20s leaves
// margin for a longer track plus a 429 backoff retry.
const TIMEOUT_MS = 20_000;

// Thrown on a 429 (OrcaRouter's free tier is rate-limited, error code
// `free_rate_limited`). Callers catch this to degrade quietly rather than fail.
export class LlmRateLimited extends Error {
  constructor(message = "OrcaRouter free-tier rate limit hit") {
    super(message);
    this.name = "LlmRateLimited";
  }
}

// Thrown on a 402 for a PAID model the key has no credits for (OrcaRouter's
// "out of credits"). Routes turn this into "add credits / pick the free model".
export class LlmNoCredits extends Error {
  constructor(message = "OrcaRouter key is out of credits for this model") {
    super(message);
    this.name = "LlmNoCredits";
  }
}

// Thrown on a 401/403 — the key is invalid/unauthorized, or (403
// model_access_denied) valid but not scoped for the requested model. Routes turn
// this into a clear "check your key / model" hint instead of a raw 502.
export class LlmBadKey extends Error {
  constructor(message = "OrcaRouter key was rejected (invalid or wrong scope)") {
    super(message);
    this.name = "LlmBadKey";
  }
}

// Thrown when a request exceeds the timeout — usually a slow *reasoning* model
// that ignores reasoning_effort:"none" (e.g. qwen3.5-flash burns ~1-2k thinking
// tokens and takes 15-40s). Routes turn this into "pick a faster model".
export class LlmTimeout extends Error {
  constructor(message = "OrcaRouter request timed out (model too slow)") {
    super(message);
    this.name = "LlmTimeout";
  }
}

// Thrown when the FREE allowance is used up across all keys (402
// free_quota_exhausted — the per-key daily cap). Distinct from a transient 429:
// retrying won't help today, so routes tell the user it's used up for now.
export class LlmFreeExhausted extends Error {
  constructor(message = "OrcaRouter free allowance is used up") {
    super(message);
    this.name = "LlmFreeExhausted";
  }
}

// Parse a comma-separated key list from an env var into a trimmed, non-empty
// array (shared by the free pool and the paid fallback pool).
function parseKeys(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// The server's pool of OrcaRouter keys. `ORCAROUTER_API_KEY` may be a single key
// or a comma-separated list — each free key is capped at ~50 requests/day, so
// pooling several multiplies capacity. Requests fail over across them on 429.
export function serverKeys(): string[] {
  return parseKeys(process.env.ORCAROUTER_API_KEY);
}

// The PAID fallback: a credited key (or comma list) used ONLY when the free pool
// is exhausted/rate-limited, on a fixed cheap model (`ORCAROUTER_PAID_MODEL`).
// Returns null when no paid key is configured (fallback disabled → AI just
// degrades as before). Server-only, like every key here; never sent to the client.
export function paidFallback(): { keys: string[]; model: string } | null {
  const keys = parseKeys(process.env.ORCAROUTER_PAID_KEY);
  return keys.length ? { keys, model: PAID_MODEL } : null;
}

// How a request is allowed to use AI:
//   "user"      — the caller pasted their OWN key; unlimited, not our concern.
//   "unlimited" — the caller typed the owner's bypass secret; uses the SERVER
//                 key with no quota (a convenience for the deployer).
//   "free"      — using the SERVER key on the shared free quota (counted).
export type AiMode = "user" | "unlimited" | "free";
// `keys` is tried in order with failover on 429 (one entry for a user key; the
// whole server pool for free/unlimited). `fallback`, when present, is the PAID
// key+model tried only after the primary pool is exhausted/rate-limited (so the
// shared AI "always works" at a few cents instead of just failing). A user's own
// key gets no fallback — they spend (and choose) for themselves.
export type AiAccess = {
  keys: string[];
  mode: AiMode;
  model: string;
  fallback?: { keys: string[]; model: string };
};

// The model every SHARED-key request uses — `orcarouter/free`, the only free one.
// Only a user with their OWN pasted key may override it (e.g. a cheap paid model
// that dodges the free-pool congestion). Neither a plain guest ("free") nor the
// owner's bypass ("unlimited") can override, so a shared key never spends on a
// pricier model.
export const DEFAULT_MODEL = MODEL;

// Resolve which key to use, under what policy, and with which model. `reqKey` is
// the optional `x-orca-key` header (the user's own key, or the bypass secret);
// `reqModel` is the optional `x-orca-model` header (honored only for own keys).
// Returns null when no key is available at all (AI off). The server key is never
// returned to the client — this runs server-side only.
export function resolveAccess(
  reqKey?: string | null,
  reqModel?: string | null
): AiAccess | null {
  const own = reqKey?.trim();
  const pool = serverKeys();
  const secret = process.env.AI_BYPASS_SECRET;

  const fallback = paidFallback() ?? undefined; // paid safety net for shared-key use

  // Owner's magic word → the shared pool with no quota, LOCKED to the free model
  // (`orcarouter/free` — the only genuinely-free one). The bypass is a free
  // convenience, never a way to spend: no model override, no paid fallback. Only a
  // pasted OWN key unlocks paid models.
  if (own && secret && own === secret) {
    return pool.length ? { keys: pool, mode: "unlimited", model: DEFAULT_MODEL } : null;
  }
  // A real user-supplied key → theirs to spend, no quota, and they may pick the
  // model (falling back to the free default). No paid fallback: not our key.
  if (own) {
    return { keys: [own], mode: "user", model: reqModel?.trim() || DEFAULT_MODEL };
  }
  // Otherwise the shared server key pool under the free quota — always free model,
  // with the paid fallback behind it so a busy/exhausted pool still serves.
  if (pool.length) return { keys: pool, mode: "free", model: DEFAULT_MODEL, fallback };
  return null;
}

// Whether the SERVER has at least one key configured. Surfaced to the client (as
// a bare boolean) by /api/ai/status so the UI can show AI affordances. The key
// values themselves never leave the server.
export function serverKeyPresent(): boolean {
  return serverKeys().length > 0;
}

// List the model ids a key can access, from OrcaRouter's `/v1/models` (which is
// already filtered to the key's scope). Populates the ⚙ Settings model picker so
// users pick ids that actually exist/are allowed instead of guessing. Server-only
// — the key never leaves. Throws LlmBadKey on 401/403; returns a sorted id list.
export async function listModels(key: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new LlmBadKey();
  if (!res.ok) throw new Error(`OrcaRouter ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? [])
    .map((m) => (typeof m?.id === "string" ? m.id : ""))
    .filter(Boolean)
    .sort();
}

type Message = { role: "system" | "user" | "assistant"; content: string };

// Pull a JSON value out of a model reply. Models sometimes wrap JSON in prose or
// ```json fences; grab the first {...} or [...] span and parse that.
function extractJson<T>(content: string): T {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through to span extraction
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === "[" ? "]" : "}";
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
  }
  throw new Error("no JSON found in LLM reply");
}

// Each round tries every key once (fast failover across the pool); if ALL keys
// are 429 (free pool saturated / daily caps hit), we back off and retry the
// whole pool. Delays between rounds; the total is bounded by the timeout.
const RETRY_DELAYS_MS = [1500, 3000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Try one pool of keys with one model until it serves a JSON reply. On a 429 we
// fail over to the next key, and only when EVERY key is 429 do we back off and
// retry the whole pool. Throws LlmRateLimited when the pool stays rate-limited,
// LlmFreeExhausted when every key is daily-exhausted, LlmNoCredits on a paid
// 402, or a plain Error on other failures.
async function runPool<T>(
  keys: string[],
  model: string,
  messages: Message[],
  signal: AbortSignal
): Promise<T> {
  if (keys.length === 0) throw new Error("no OrcaRouter key available");

  const body = JSON.stringify({
    model,
    messages,
    temperature: 0, // deterministic + enables OrcaRouter's cross-provider cache
    // Our tasks (romaji, mood queries, title cleanup) are mechanical — they
    // need no chain-of-thought. The free router otherwise picks a reasoning
    // model that burns ~14k "thinking" tokens on a full song and takes >60s
    // (blowing the timeout → 502). "none" cuts that to a couple of seconds.
    // (Do NOT use "low": the free tier rejects it with 402.)
    reasoning_effort: "none",
  });

  for (let round = 0; ; round++) {
    // Per-round tally of WHY no key served us, so we can decide whether to retry.
    let sawRateLimit = false; // 429 — transient, worth a backoff retry
    let sawFreeExhausted = false; // 402 free_quota_exhausted — daily cap, won't recover now

    for (const key of keys) {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
          signal,
        });
      } catch (e) {
        // The timeout (or an aborted signal) fired. The signal bounds the whole
        // operation, so retrying other keys is pointless — surface it as a slow
        // model so the UI can suggest a faster one.
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
          throw new LlmTimeout();
        }
        throw e;
      }

      if (res.status === 429) {
        sawRateLimit = true;
        continue; // this key is momentarily busy → try the next key
      }
      if (res.status === 401 || res.status === 403) {
        // Bad/unauthorized key, or a valid key without access to this model.
        // Not transient and not a pool-capacity issue — surface it directly.
        throw new LlmBadKey();
      }
      if (res.status === 402) {
        // Two very different 402s: the free DAILY allowance is used up for this
        // key (fail over / give up on free), vs. a PAID model with no credits.
        const text = await res.text().catch(() => "");
        if (text.includes("free_quota_exhausted")) {
          sawFreeExhausted = true;
          continue; // this free key is done for today → try the next key
        }
        throw new LlmNoCredits();
      }
      if (!res.ok) {
        throw new Error(`OrcaRouter ${res.status}: ${await res.text().catch(() => "")}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty LLM reply");
      return extractJson<T>(content);
    }

    // No key served us this round. A rate-limited key might recover, so back off
    // and retry the whole pool. If the ONLY problem is daily-exhausted keys,
    // retrying is pointless — surface that distinctly right away.
    if (sawRateLimit && round < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[round]);
      continue;
    }
    if (sawFreeExhausted && !sawRateLimit) throw new LlmFreeExhausted();
    throw new LlmRateLimited();
  }
}

// Ask the model for a JSON reply and return it parsed. `keys` is the pool from
// resolveAccess() (one entry for a user key; several for the server pool). When
// `fallback` is set and the primary pool can't serve — its free allowance is
// exhausted OR it stays rate-limited after backoff — we try the PAID fallback
// pool once (a credited key on a fixed cheap model), so the shared AI keeps
// working for a few cents instead of failing. If the fallback also fails we
// surface the ORIGINAL free-tier error (so a guest sees "free's used up, paste
// your key", never the owner's billing problem).
export async function llmJSON<T>(opts: {
  messages: Message[];
  keys: string[];
  model?: string;
  fallback?: { keys: string[]; model: string };
  signal?: AbortSignal;
}): Promise<T> {
  const { messages, keys, model = MODEL, fallback } = opts;
  // A caller-supplied signal (or the default timeout) bounds the TOTAL time —
  // the primary attempt and any paid fallback share this one budget.
  const signal = opts.signal ?? AbortSignal.timeout(TIMEOUT_MS);

  try {
    return await runPool<T>(keys, model, messages, signal);
  } catch (primary) {
    // Fall back to the paid pool only when the FREE pool itself couldn't serve.
    const freeCouldNotServe =
      primary instanceof LlmFreeExhausted || primary instanceof LlmRateLimited;
    if (fallback && freeCouldNotServe) {
      try {
        return await runPool<T>(fallback.keys, fallback.model, messages, signal);
      } catch (fb) {
        // Paid fallback failed too (e.g. the credited key is out of credits).
        // Log for the owner, but show the caller the free-tier status instead.
        console.warn("[llm] paid fallback failed:", fb);
        throw primary;
      }
    }
    throw primary;
  }
}
