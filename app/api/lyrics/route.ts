import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getLyrics, reportWrongLyrics } from "@/lib/lyrics";
import { clearRejectedLyrics, getCachedLyrics, setLyricsOffset } from "@/lib/db";

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
    const cached = getCachedLyrics(videoId);
    const offset = cached?.offset ?? 0;
    // `hasRejected` lets the host show a "Restore" button only when a match was
    // reported wrong for this song.
    const hasRejected = (cached?.rejected.length ?? 0) > 0;
    if (!result) return NextResponse.json({ found: false, offset, hasRejected });
    return NextResponse.json({ found: true, offset, hasRejected, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "lyrics failed";
    return NextResponse.json({ error: message, found: false }, { status: 502 });
  }
}

// POST /api/lyrics  { videoId, offset }    → persist the manual sync nudge
//                   { videoId, restore: true } → undo a wrong-lyrics report,
//                     forgetting the rejected matches so they can return. Used by
//                     the host-only "Restore" button.
export async function POST(req: NextRequest) {
  let body: { videoId?: unknown; offset?: unknown; restore?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const videoId = typeof body.videoId === "string" ? body.videoId.trim() : "";
  if (!videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }

  if (body.restore === true) {
    clearRejectedLyrics(videoId);
    return NextResponse.json({ ok: true });
  }

  const offset = Number(body.offset);
  // Clamp to a sane range so a bad client can't store nonsense.
  if (!Number.isFinite(offset) || Math.abs(offset) > 60) {
    return NextResponse.json({ error: "invalid offset" }, { status: 400 });
  }

  setLyricsOffset(videoId, offset);
  return NextResponse.json({ ok: true });
}

// DELETE /api/lyrics?videoId=...
// Report the current lyrics as wrong (signed-in users only): records the match as
// rejected and clears the cache so the next lookup finds a different match.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const videoId = req.nextUrl.searchParams.get("videoId")?.trim();
  if (!videoId) {
    return NextResponse.json({ error: "missing videoId" }, { status: 400 });
  }
  reportWrongLyrics(videoId);
  return NextResponse.json({ ok: true });
}
