"use client";

// Warm the server-side lyrics cache ahead of time so the Lyrics tab is instant.
// Lyrics are cached in SQLite by videoId, so simply hitting /api/lyrics early
// (for the now-playing song and the next few queued songs) means the result is
// already there when anyone opens the Lyrics tab — no spinner. Fire-and-forget;
// we don't use the response, only its side effect of populating the cache.

import { useEffect, useRef } from "react";
import type { QueueItem } from "@/lib/types";

export function usePrefetchLyrics(
  nowPlaying: QueueItem | null,
  queue: QueueItem[],
  upcoming = 3
) {
  // videoIds we've already kicked off a prefetch for this session.
  const done = useRef<Set<string>>(new Set());

  useEffect(() => {
    const targets = [nowPlaying, ...queue.slice(0, upcoming)].filter(
      (s): s is QueueItem => !!s
    );
    for (const item of targets) {
      if (done.current.has(item.videoId)) continue;
      done.current.add(item.videoId);
      const params = new URLSearchParams({
        videoId: item.videoId,
        title: item.title,
        duration: String(Math.round(item.durationSec || 0)),
      });
      fetch(`/api/lyrics?${params}`).catch(() => {
        // Network hiccup — forget it so the next state update can retry.
        done.current.delete(item.videoId);
      });
    }
  }, [nowPlaying, queue, upcoming]);
}
