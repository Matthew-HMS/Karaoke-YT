import { NextResponse } from "next/server";
import { getTrending } from "@/lib/recommend";

// Shells out to yt-dlp → Node runtime, not statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/trending → the anonymous "Top hits" feed (a YouTube charts playlist).
// Public; shown in the Search tab before a query when signed out.
export async function GET() {
  try {
    const results = await getTrending();
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "trending fetch failed";
    return NextResponse.json({ error: message, results: [] }, { status: 502 });
  }
}
