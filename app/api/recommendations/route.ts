import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getRecommendations } from "@/lib/recommend";
import { regionFromRequest } from "@/lib/region";

// Shells out to yt-dlp → Node runtime, not statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/recommendations → personalized "For you" feed based on the signed-in
// user's play history + favorites. Auth required (no session → 401).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required", results: [] }, { status: 401 });
  }

  const region = regionFromRequest(req);
  try {
    const results = await getRecommendations(session.user.id, region);
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "recommendation failed";
    return NextResponse.json({ error: message, results: [] }, { status: 502 });
  }
}
