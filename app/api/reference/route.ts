import { NextRequest, NextResponse } from "next/server";
import { getCachedContour } from "@/lib/db";
import { ensureContour, getContourError } from "@/lib/reference";

// Spawns yt-dlp/ffmpeg + hits SQLite, so Node runtime and never static.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/reference?videoId=...
// Returns the song's cached pitch contour for the karaoke target line:
//   { found: true, fps, midis: number[] }       — ready (midi/frame, -1=unvoiced)
//   { found: false, status: "pending" }          — generating; poll again shortly
//   { found: false, status: "error", error }     — last attempt failed (the why)
// A miss kicks off generation in the background (deduped + backed off), so the
// next poll for a popular/queued song usually hits the cache.
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId")?.trim();
  if (!videoId) {
    return NextResponse.json({ error: "missing videoId" }, { status: 400 });
  }

  const cached = getCachedContour(videoId);
  if (cached) {
    return NextResponse.json({ found: true, fps: cached.fps, midis: cached.midis });
  }

  ensureContour(videoId);
  // Surface a recent failure instead of an endless "pending", so a stuck target
  // line is diagnosable (e.g. `curl …/api/reference?videoId=…`).
  const error = getContourError(videoId);
  return NextResponse.json(
    error ? { found: false, status: "error", error } : { found: false, status: "pending" }
  );
}
