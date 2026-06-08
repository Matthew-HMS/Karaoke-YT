import { NextResponse } from "next/server";
import { recentlyPlayed } from "@/lib/db";

// GET /api/history → most-recently played songs (de-duplicated).
export async function GET() {
  return NextResponse.json({ results: recentlyPlayed(30) });
}
