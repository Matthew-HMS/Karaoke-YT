import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveAccess } from "@/lib/llm";
import { aiErrorResponse } from "@/lib/aiRoute";
import { translateLines, isTranslateLang } from "@/lib/translate";

// Hits SQLite + OrcaRouter → Node runtime, never static.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/translate  { videoId, lines: string[], lang, refresh? }  → { translation }
// Returns the lyrics translated to `lang`, aligned 1:1 with `lines`, or
// `translation: null` when the song is already in that language. Cached per
// (videoId, lang). `refresh` re-translates, bypassing the cache. Key/quota policy
// via resolveAccess.
export async function POST(req: NextRequest) {
  const access = resolveAccess(
    req.headers.get("x-orca-key"),
    req.headers.get("x-orca-model")
  );
  if (!access) {
    return NextResponse.json({ error: "AI not configured", translation: null }, { status: 503 });
  }

  let body: { videoId?: unknown; lines?: unknown; lang?: unknown; refresh?: unknown };
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
  if (!videoId || !lines || !isTranslateLang(body.lang)) {
    return NextResponse.json(
      { error: "videoId, lines and a valid lang required" },
      { status: 400 }
    );
  }
  const refresh = body.refresh === true;

  const session = await auth();
  const clientId =
    session?.user?.id || req.headers.get("x-ai-client")?.trim() || "anon";

  try {
    const translation = await translateLines(videoId, lines, body.lang, {
      access,
      clientId,
      refresh,
    });
    return NextResponse.json({ translation });
  } catch (err) {
    return aiErrorResponse(err, { translation: null });
  }
}
