import { NextRequest, NextResponse } from "next/server";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/db";

// GET /api/favorites → all starred songs.
export async function GET() {
  return NextResponse.json({ results: listFavorites() });
}

// POST /api/favorites → star a song. Body: { videoId, title, thumbnail, durationSec }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }
  addFavorite({
    videoId: String(body.videoId),
    title: String(body.title ?? "YouTube video"),
    thumbnail: String(body.thumbnail ?? ""),
    durationSec: Number(body.durationSec ?? 0),
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/favorites?videoId=... → unstar.
export async function DELETE(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }
  removeFavorite(videoId);
  return NextResponse.json({ ok: true });
}
