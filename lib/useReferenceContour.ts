"use client";

// Host-side fetch of a song's reference pitch contour (the karaoke target line).
// Generation is async on the server (download + decode + analyze), so a miss
// returns `pending` and kicks off the work; we poll a few times until it lands.
// Returns null until the contour for the CURRENT videoId is ready — the result
// is tagged with its videoId and filtered at render time, so a previous song's
// contour never briefly shows on the next one.

import { useEffect, useState } from "react";

export type Contour = { fps: number; midis: number[] };

const POLL_MS = 5000;
const MAX_TRIES = 24; // ~2 min of polling before giving up

export function useReferenceContour(videoId: string | undefined): Contour | null {
  const [data, setData] = useState<
    { videoId: string; fps: number; midis: number[] } | null
  >(null);

  useEffect(() => {
    if (!videoId) return;
    let active = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const r = await fetch(
          `/api/reference?videoId=${encodeURIComponent(videoId)}`
        );
        const d = await r.json();
        if (!active) return;
        if (d.found) {
          setData({ videoId, fps: d.fps, midis: d.midis });
          return;
        }
      } catch {
        // ignore — retry below
      }
      if (active && ++tries < MAX_TRIES) timer = setTimeout(poll, POLL_MS);
    };
    poll();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [videoId]);

  // Only surface the contour once it matches the song being asked about.
  return data && data.videoId === videoId
    ? { fps: data.fps, midis: data.midis }
    : null;
}
