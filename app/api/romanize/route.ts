import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveAccess } from "@/lib/llm";
import { aiErrorResponse } from "@/lib/aiRoute";
import { romanizeLines } from "@/lib/romanize";

// Hits SQLite + OrcaRouter → Node runtime, never static.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/romanize  { videoId, lines: string[] }  → { romaji: string[] | null }
// Returns Hepburn romaji aligned 1:1 with `lines` for a Japanese song, or
// `romaji: null` when the song isn't Japanese. Cached in SQLite per videoId
// (cache hits don't spend a free use). Key/quota policy via resolveAccess.
export async function POST(req: NextRequest) {
  const access = resolveAccess(
    req.headers.get("x-orca-key"),
    req.headers.get("x-orca-model")
  );
  if (!access) {
    return NextResponse.json({ error: "AI not configured", romaji: null }, { status: 503 });
  }

  let body: { videoId?: unknown; lines?: unknown };
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

  const session = await auth();
  const clientId =
    session?.user?.id || req.headers.get("x-ai-client")?.trim() || "anon";

  try {
    const romaji = await romanizeLines(videoId, lines, { access, clientId });
    return NextResponse.json({ romaji });
  } catch (err) {
    return aiErrorResponse(err, { romaji: null });
  }
}
