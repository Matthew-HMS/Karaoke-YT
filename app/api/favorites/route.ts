import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/db";

// All favorites are scoped to the signed-in user. No session → 401.

// GET /api/favorites → the current user's starred songs.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  return NextResponse.json({ results: listFavorites(session.user.id) });
}

// POST /api/favorites → star a song. Body: { videoId, title, thumbnail, durationSec }
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }
  addFavorite(session.user.id, {
    videoId: String(body.videoId),
    title: String(body.title ?? "YouTube video"),
    thumbnail: String(body.thumbnail ?? ""),
    durationSec: Number(body.durationSec ?? 0),
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/favorites?videoId=... → unstar.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const videoId = req.nextUrl.searchParams.get("videoId");
  if (!videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }
  removeFavorite(session.user.id, videoId);
  return NextResponse.json({ ok: true });
}
