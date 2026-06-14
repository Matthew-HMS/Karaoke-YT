import { NextRequest, NextResponse } from "next/server";
import { searchSongs } from "@/lib/search";

// This route shells out to yt-dlp, so it must run on the Node runtime (not edge)
// and not be statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/search?q=...&karaokeOnly=1&limit=20
// Quota-free yt-dlp, falling back to the YouTube Data API.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const q = p.get("q")?.trim();
  if (!q) return NextResponse.json({ results: [] });

  const karaokeOnly = p.get("karaokeOnly") === "1"; // off by default
  const limit = Math.min(Math.max(Number(p.get("limit")) || 20, 10), 100);

  try {
    const { results, source } = await searchSongs(q, { karaokeOnly, limit });
    return NextResponse.json({ results, source });
  } catch (err) {
    // Both backends failed (e.g. yt-dlp missing AND no API key / quota gone).
    const message = err instanceof Error ? err.message : "search failed";
    const status = message.includes("YOUTUBE_API_KEY") ? 503 : 502;
    return NextResponse.json({ error: message, results: [] }, { status });
  }
}
