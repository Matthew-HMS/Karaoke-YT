import { NextRequest, NextResponse } from "next/server";
import { extractVideoId, getVideoMeta } from "@/lib/youtube";

// POST /api/parse-link  { url }
// Extracts a videoId from a pasted YouTube URL and returns its metadata.
export async function POST(req: NextRequest) {
  const { url } = await req.json().catch(() => ({ url: "" }));
  const videoId = extractVideoId(String(url || ""));
  if (!videoId) {
    return NextResponse.json(
      { error: "That doesn’t look like a YouTube link." },
      { status: 400 }
    );
  }

  try {
    const meta = await getVideoMeta(videoId);
    if (!meta) {
      // No API key / not found: fall back to a usable entry anyway.
      return NextResponse.json({
        result: {
          videoId,
          title: "YouTube video",
          thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
          durationSec: 0,
        },
      });
    }
    return NextResponse.json({ result: meta });
  } catch {
    return NextResponse.json({
      result: {
        videoId,
        title: "YouTube video",
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        durationSec: 0,
      },
    });
  }
}
