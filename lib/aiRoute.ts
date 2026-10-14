// Shared error → HTTP mapping for the AI routes, so quota and rate-limit
// failures surface consistently (and the client can show the right hint):
//   AiQuotaExceeded → 402 { code: "quota_exceeded", limit }
//   LlmBadKey       → 401 { code: "bad_key" }
//   LlmNoCredits    → 402 { code: "no_credits" }
//   LlmFreeExhausted→ 402 { code: "free_exhausted" }
//   LlmRateLimited  → 429 { code: "rate_limited" }
//   LlmTimeout      → 504 { code: "slow_model" }
//   anything else   → 502 { error: <message> }
// `extra` carries the route's empty payload (e.g. { results: [] }) so the shape
// stays consistent with its success response.

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
      { error: "free_exhausted", code: "free_exhausted", ...extra },
      { status: 402 }
    );
  }
  if (err instanceof LlmRateLimited) {
    return NextResponse.json(
      { error: "rate_limited", code: "rate_limited", ...extra },
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
