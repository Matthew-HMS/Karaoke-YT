import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getRecommendations } from "@/lib/recommend";

// Shells out to yt-dlp → Node runtime, not statically optimized.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/recommendations → personalized "For you" feed based on the signed-in
// user's play history + favorites. Auth required (no session → 401).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required", results: [] }, { status: 401 });
  }

  try {
    const results = await getRecommendations(session.user.id);
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "recommendation failed";
    return NextResponse.json({ error: message, results: [] }, { status: 502 });
  }
}
