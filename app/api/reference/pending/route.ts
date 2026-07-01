import { NextRequest, NextResponse } from "next/server";
import { ingestAuthOk } from "@/lib/ingestAuth";
import { listWanted } from "@/lib/reference";

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
