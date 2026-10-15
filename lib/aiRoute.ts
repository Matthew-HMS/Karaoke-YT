// Shared error → HTTP mapping for the AI routes, so quota and rate-limit
// failures surface consistently (and the client can show the right hint):
//   AiQuotaExceeded → 402 { code: "quota_exceeded", limit }
//   LlmBadKey       → 401 { code: "bad_key" }
//   LlmNoCredits    → 402 { code: "no_credits" }
//   LlmFreeExhausted→ 402 { code: "free_exhausted" }
//   LlmRateLimited  → 429 { code: "rate_limited", retryAfter? }
//   LlmTimeout      → 504 { code: "slow_model" }
//   anything else   → 502 { error: <message> }
// `extra` carries the route's empty payload (e.g. { results: [] }) so the shape
// stays consistent with its success response.
//
// One twist: when the paid fallback was tried behind a rate-limit/exhaustion and
// ALSO failed, the code becomes "backup_failed" instead. The status stays the
// same, but the hint has to change — retrying can't help until the deployer fixes
// the backup key. The fallback's own reason stays server-side (lib/llm.ts logs
// it), so a guest never sees the owner's billing detail.

import { NextResponse } from "next/server";
import { LlmBadKey, LlmFreeExhausted, LlmNoCredits, LlmRateLimited, LlmTimeout } from "./llm";
import { AiQuotaExceeded } from "./aiCall";

export function aiErrorResponse(
  err: unknown,
  extra: Record<string, unknown> = {}
): NextResponse {
  if (err instanceof AiQuotaExceeded) {
    return NextResponse.json(
      { error: "quota", code: "quota_exceeded", limit: err.limit, ...extra },
      { status: 402 }
    );
  }
  if (err instanceof LlmBadKey) {
    return NextResponse.json(
      { error: "bad_key", code: "bad_key", ...extra },
      { status: 401 }
    );
  }
  if (err instanceof LlmNoCredits) {
    return NextResponse.json(
      { error: "no_credits", code: "no_credits", ...extra },
      { status: 402 }
    );
  }
  if (err instanceof LlmFreeExhausted) {
    return NextResponse.json(
      {
        error: "free_exhausted",
        code: err.fallbackFailed ? "backup_failed" : "free_exhausted",
        ...extra,
      },
      { status: 402 }
    );
  }
  if (err instanceof LlmRateLimited) {
    return NextResponse.json(
      {
        error: "rate_limited",
        code: err.fallbackFailed ? "backup_failed" : "rate_limited",
        // Hours, for a saturated free pool — the UI names the real wait.
        retryAfter: err.retryAfterSeconds,
        ...extra,
      },
      { status: 429 }
    );
  }
  if (err instanceof LlmTimeout) {
    return NextResponse.json(
      { error: "slow_model", code: "slow_model", ...extra },
      { status: 504 }
    );
  }
  const message = err instanceof Error ? err.message : "AI request failed";
  return NextResponse.json({ error: message, ...extra }, { status: 502 });
}
