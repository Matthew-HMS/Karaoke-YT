import { NextRequest, NextResponse } from "next/server";
import { getTrending } from "@/lib/recommend";
import { regionFromRequest } from "@/lib/region";

// Shells out to yt-dlp → Node runtime, not statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/trending?region=XX → the anonymous "Top hits" feed. Public; shown in
// the Search tab before a query when signed out. `region` biases the feed toward
// uploads playable in the viewer's country.
export async function GET(req: NextRequest) {
  const region = regionFromRequest(req);
  try {
    const results = await getTrending(region);
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "trending fetch failed";
    return NextResponse.json({ error: message, results: [] }, { status: 502 });
  }
}
