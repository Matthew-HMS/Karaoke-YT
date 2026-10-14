import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveAccess, serverKeyPresent } from "@/lib/llm";
import { AI_FREE_LIMIT } from "@/lib/aiCall";
import { aiUsageCount } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/ai/status → { enabled, freeLimit, mode, remaining }
// - enabled:   the SERVER has a default OrcaRouter key (so AI can be offered).
// - freeLimit: free uses the shared key allows before a user must paste their own.
// - mode:      how THIS caller is using AI — "user" (own key), "unlimited"
//              (bypass secret), "free" (shared quota), or null (no key).
// - remaining: free uses left for this caller (only meaningful in "free" mode;
//              null when unlimited/unknown).
// Booleans/numbers only — the key value itself is never sent to the browser.
export async function GET(req: NextRequest) {
  const access = resolveAccess(req.headers.get("x-orca-key"));
  let remaining: number | null = null;
  if (access?.mode === "free") {
    const session = await auth();
    const clientId =
      session?.user?.id || req.headers.get("x-ai-client")?.trim() || "anon";
    remaining = Math.max(0, AI_FREE_LIMIT - aiUsageCount(clientId));
  }
  return NextResponse.json({
    enabled: serverKeyPresent(),
    freeLimit: AI_FREE_LIMIT,
    mode: access?.mode ?? null,
    remaining,
  });
}
