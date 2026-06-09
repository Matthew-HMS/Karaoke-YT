import { NextRequest, NextResponse } from "next/server";
import { searchSongs } from "@/lib/search";

// This route shells out to yt-dlp, so it must run on the Node runtime (not edge)
// and not be statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/search?q=...&karaokeOnly=1
// Tries the quota-free yt-dlp backend first, falls back to the YouTube Data API.
// karaokeOnly defaults ON: biases results toward singable karaoke tracks.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ results: [] });

  const karaokeOnly = req.nextUrl.searchParams.get("karaokeOnly") !== "0";

  try {
    const { results, source } = await searchSongs(q, karaokeOnly);
    return NextResponse.json({ results, source });
  } catch (err) {
    // Both backends failed (e.g. yt-dlp missing AND no API key / quota gone).
    const message = err instanceof Error ? err.message : "search failed";
    const status = message.includes("YOUTUBE_API_KEY") ? 503 : 502;
    return NextResponse.json({ error: message, results: [] }, { status });
  }
}
