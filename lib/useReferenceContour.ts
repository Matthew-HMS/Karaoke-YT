"use client";

// Host-side fetch of a song's reference pitch contour (the karaoke target line).
// Generation is async on the server (download + decode + analyze), so a miss
// returns `pending` and kicks off the work; we poll a few times until it lands.
// Returns the contour for the CURRENT videoId once ready (tagged + filtered so a
// previous song's contour never briefly shows on the next one), plus a `status`
// so the UI can tell the user when the target line is unavailable (generation
// failed — e.g. YouTube bot-walls the download — or never arrived).

import { useEffect, useState } from "react";

export type Contour = { fps: number; midis: number[] };
// idle: no song. pending: generating / polling. ready: contour in hand.
// unavailable: generation failed, or didn't land before we gave up polling.
export type RefStatus = "idle" | "pending" | "ready" | "unavailable";

const POLL_MS = 5000;
const MAX_TRIES = 24; // ~2 min of polling before giving up

export function useReferenceContour(videoId: string | undefined): {
  contour: Contour | null;
  status: RefStatus;
} {
  const [state, setState] = useState<{
    videoId: string;
    contour: Contour | null;
    status: RefStatus;
  }>({ videoId: "", contour: null, status: "idle" });

  useEffect(() => {
    if (!videoId) {
      setState({ videoId: "", contour: null, status: "idle" });
      return;
    }
    let active = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    setState({ videoId, contour: null, status: "pending" });

    const poll = async () => {
      try {
        const r = await fetch(
          `/api/reference?videoId=${encodeURIComponent(videoId)}`
        );
        const d = await r.json();
        if (!active) return;
        if (d.found) {
          setState({ videoId, contour: { fps: d.fps, midis: d.midis }, status: "ready" });
          return;
        }
        // Generation failed (e.g. yt-dlp bot-wall / unavailable video) — stop and
        // surface it, instead of polling for two minutes to no avail.
        if (d.status === "error") {
          setState({ videoId, contour: null, status: "unavailable" });
          return;
        }
      } catch {
        // network blip — fall through to retry
      }
      if (active && ++tries < MAX_TRIES) {
        timer = setTimeout(poll, POLL_MS);
      } else if (active) {
        setState({ videoId, contour: null, status: "unavailable" }); // gave up
      }
    };
    poll();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [videoId]);

  // Only surface state for the song currently being asked about.
  return state.videoId === videoId
    ? { contour: state.contour, status: state.status }
    : { contour: null, status: videoId ? "pending" : "idle" };
}
