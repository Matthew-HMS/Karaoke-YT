import { NextRequest, NextResponse } from "next/server";
import { getLyrics } from "@/lib/lyrics";
import { getCachedLyrics, setLyricsOffset } from "@/lib/db";

// Hits SQLite + external lyrics APIs, so Node runtime and never statically
// optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/lyrics?videoId=...&title=...&duration=120[&refresh=1]
// Returns { found, synced, lines, source, offset } for the now-playing song.
// `found: false` means no lyrics anywhere (and is cached so we don't re-query).
// `offset` is the saved manual sync nudge (seconds) for this video.
// `refresh=1` bypasses the cache and re-queries the providers.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const videoId = p.get("videoId")?.trim();
  const title = p.get("title")?.trim();
  const duration = Number(p.get("duration")) || 0;
  const force = p.get("refresh") === "1";

  if (!videoId || !title) {
    return NextResponse.json({ error: "missing videoId or title" }, { status: 400 });
  }

  try {
    const result = await getLyrics(videoId, title, duration, { force });
    const offset = getCachedLyrics(videoId)?.offset ?? 0;
    if (!result) return NextResponse.json({ found: false, offset });
    return NextResponse.json({ found: true, offset, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "lyrics failed";
    return NextResponse.json({ error: message, found: false }, { status: 502 });
  }
}

// POST /api/lyrics  { videoId, offset }
// Persists the manual sync nudge for a video so it sticks across plays.
export async function POST(req: NextRequest) {
  let body: { videoId?: unknown; offset?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
  const offset = Number(body.offset);
  // Clamp to a sane range so a bad client can't store nonsense.
  if (!videoId || !Number.isFinite(offset) || Math.abs(offset) > 60) {
    return NextResponse.json({ error: "invalid videoId or offset" }, { status: 400 });
  }

  setLyricsOffset(videoId, offset);
  return NextResponse.json({ ok: true });
}
