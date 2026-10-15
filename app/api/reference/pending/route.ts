import { NextRequest, NextResponse } from "next/server";
import { ingestAuthOk } from "@/lib/ingestAuth";
import { clearWanted, listWanted } from "@/lib/reference";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/reference/pending → { videoIds: string[] }
// The off-cluster worker polls this for videos that need a contour generated.
// Auth: `Authorization: Bearer <REFERENCE_INGEST_TOKEN>`.
export async function GET(req: NextRequest) {
  if (!ingestAuthOk(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ videoIds: listWanted() });
}

// POST /api/reference/pending  { videoId }
// The worker calls this to DROP a video it has given up on (dead / unfetchable),
// so it stops being handed out every poll and doesn't come back on restart. Safe
// to drop: if the song is played again, ensureContour re-adds it (INSERT OR
// IGNORE), so a once-transient failure gets another chance. Auth as above.
export async function POST(req: NextRequest) {
  if (!ingestAuthOk(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const videoId = (body as { videoId?: unknown })?.videoId;
  if (typeof videoId !== "string" || !videoId) {
    return NextResponse.json({ error: "videoId required" }, { status: 400 });
  }
  clearWanted(videoId);
  return NextResponse.json({ ok: true });
}
