import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { suggestSongs } from "@/lib/aiSuggest";
import { resolveAccess } from "@/lib/llm";
import { aiErrorResponse } from "@/lib/aiRoute";
import { regionFromRequest } from "@/lib/region";

// Calls OrcaRouter + shells out to yt-dlp → Node runtime, never static.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/ai/suggest  { prompt, exclude? }  → { results }
// Turns a natural-language mood/prompt into real, queueable songs. Key policy via
// resolveAccess (own key / owner bypass / shared free quota). The free quota is
// keyed by the signed-in user id, else the `x-ai-client` device id.
export async function POST(req: NextRequest) {
  const access = resolveAccess(
    req.headers.get("x-orca-key"),
    req.headers.get("x-orca-model")
  );
  if (!access) {
    return NextResponse.json({ error: "AI not configured", results: [] }, { status: 503 });
  }

  let body: { prompt?: unknown; exclude?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "prompt required", results: [] }, { status: 400 });
  }
  // Titles already shown (for "Load more"); cap so a client can't send a huge list.
  const exclude = Array.isArray(body.exclude)
    ? body.exclude.filter((t): t is string => typeof t === "string").slice(0, 60)
    : [];

  const session = await auth();
  const clientId =
    session?.user?.id || req.headers.get("x-ai-client")?.trim() || "anon";

  try {
    const region = regionFromRequest(req);
    const results = await suggestSongs(prompt, { region, access, clientId, exclude });
    return NextResponse.json({ results });
  } catch (err) {
    return aiErrorResponse(err, { results: [] });
  }
}
