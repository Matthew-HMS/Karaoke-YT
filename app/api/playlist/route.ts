import { NextRequest, NextResponse } from "next/server";
import { getPlaylistViaYtDlp } from "@/lib/ytsearch";
import { extractPlaylistId } from "@/lib/youtube";

// Shells out to yt-dlp → Node runtime, not statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/playlist  { url }
// Returns the (capped) list of videos in a pasted YouTube playlist URL.
export async function POST(req: NextRequest) {
  const { url } = await req.json().catch(() => ({ url: "" }));
  const playlistId = extractPlaylistId(String(url || ""));
  if (!playlistId) {
    return NextResponse.json(
      { error: "That doesn’t look like a YouTube playlist link." },
      { status: 400 }
    );
  }

  try {
    const results = await getPlaylistViaYtDlp(playlistId);
    if (results.length === 0) {
      return NextResponse.json(
        { error: "Couldn’t read that playlist (empty or private)." },
        { status: 404 }
      );
    }
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "playlist fetch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
