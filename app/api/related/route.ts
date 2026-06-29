import { NextRequest, NextResponse } from "next/server";
import { getRelated } from "@/lib/recommend";

// Shells out to yt-dlp → Node runtime, not statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/related?videoId=...&title=...
// Songs related to a given video (YouTube's Mix radio, quota-free). `title` is
// optional and only used to improve the keyword-search fallback. Public.
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId")?.trim();
  if (!videoId) {
    return NextResponse.json({ error: "videoId required", results: [] }, { status: 400 });
  }
  const title = req.nextUrl.searchParams.get("title") || undefined;

  try {
    const results = await getRelated(videoId, title);
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "related fetch failed";
    return NextResponse.json({ error: message, results: [] }, { status: 502 });
  }
}
