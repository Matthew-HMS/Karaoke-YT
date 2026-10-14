import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveAccess } from "@/lib/llm";
import { aiErrorResponse } from "@/lib/aiRoute";
import { furiganaLines } from "@/lib/furigana";

// Hits SQLite + OrcaRouter → Node runtime, never static.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/furigana  { videoId, lines: string[] }  → { furigana: Segment[][] | null }
// Returns per-line furigana segments for a Japanese song (hiragana readings over
// kanji), or `furigana: null` when the song isn't Japanese. Cached per videoId
// (cache hits don't spend a free use). Key/quota policy via resolveAccess.
export async function POST(req: NextRequest) {
  const access = resolveAccess(
    req.headers.get("x-orca-key"),
    req.headers.get("x-orca-model")
  );
  if (!access) {
    return NextResponse.json({ error: "AI not configured", furigana: null }, { status: 503 });
  }

  let body: { videoId?: unknown; lines?: unknown; refresh?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
  const lines =
    Array.isArray(body.lines) && body.lines.every((l) => typeof l === "string")
      ? (body.lines as string[])
      : null;
  if (!videoId || !lines) {
    return NextResponse.json({ error: "videoId and lines required" }, { status: 400 });
  }
  const refresh = body.refresh === true; // re-annotate, bypassing the cache

  const session = await auth();
  const clientId =
    session?.user?.id || req.headers.get("x-ai-client")?.trim() || "anon";

  try {
    const furigana = await furiganaLines(videoId, lines, { access, clientId, refresh });
    return NextResponse.json({ furigana });
  } catch (err) {
    return aiErrorResponse(err, { furigana: null });
  }
}
