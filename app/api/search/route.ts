import { NextRequest, NextResponse } from "next/server";
import { searchYouTube } from "@/lib/youtube";

// GET /api/search?q=...&karaokeOnly=1
// karaokeOnly defaults ON: biases results toward singable karaoke tracks.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ results: [] });

  const karaokeOnly = req.nextUrl.searchParams.get("karaokeOnly") !== "0";

  try {
    const results = await searchYouTube(q, karaokeOnly);
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "search failed";
    const status = message.includes("YOUTUBE_API_KEY") ? 503 : 502;
    return NextResponse.json({ error: message, results: [] }, { status });
  }
}
