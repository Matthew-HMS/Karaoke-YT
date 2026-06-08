"use client";

// Thin wrapper around the YouTube IFrame Player API. The host screen is the
// single source of audio/video; this component plays a videoId, reports its
// position once per second, and exposes imperative play/pause/seek/restart via
// a ref. No downloading — YouTube streams it, and seekTo() jumps instantly.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { PlayerState } from "@/lib/types";

// Minimal typing for the bits of the IFrame API we use.
type YTPlayer = {
  loadVideoById: (id: string) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  destroy: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: unknown) => YTPlayer;
      PlayerState: { ENDED: number; PLAYING: number; PAUSED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type PlayerHandle = {
  play: () => void;
  pause: () => void;
  seek: (sec: number) => void;
  restart: () => void;
};

type Props = {
  videoId: string | null;
  onReport: (state: PlayerState) => void;
  onEnded: () => void;
  onError: (videoId: string) => void;
};

let apiLoading: Promise<void> | null = null;

// Load the IFrame API script exactly once across the whole app.
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (apiLoading) return apiLoading;
  apiLoading = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiLoading;
}

export const YouTubePlayer = forwardRef<PlayerHandle, Props>(function YouTubePlayer(
  { videoId, onReport, onEnded, onError },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const currentVideo = useRef<string | null>(null);
  // Keep latest callbacks without re-initializing the player.
  const cbs = useRef({ onReport, onEnded, onError });
  cbs.current = { onReport, onEnded, onError };

  useImperativeHandle(ref, () => ({
    play: () => playerRef.current?.playVideo(),
    pause: () => playerRef.current?.pauseVideo(),
    seek: (sec) => playerRef.current?.seekTo(sec, true),
    restart: () => playerRef.current?.seekTo(0, true),
  }));

  // Initialize the player once.
  useEffect(() => {
    let cancelled = false;
    let reportTimer: ReturnType<typeof setInterval>;

    loadYouTubeApi().then(() => {
      if (cancelled || !containerRef.current || !window.YT) return;

      playerRef.current = new window.YT.Player(containerRef.current, {
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            if (videoId) {
              currentVideo.current = videoId;
              playerRef.current?.loadVideoById(videoId);
            }
          },
          onStateChange: (e: { data: number }) => {
            const YT = window.YT!;
            const p = playerRef.current;
            if (!p) return;
            if (e.data === YT.PlayerState.ENDED) {
              cbs.current.onEnded();
            } else if (e.data === YT.PlayerState.PLAYING) {
              cbs.current.onReport({
                status: "playing",
                currentTimeSec: p.getCurrentTime(),
                durationSec: p.getDuration(),
              });
            } else if (e.data === YT.PlayerState.PAUSED) {
              cbs.current.onReport({
                status: "paused",
                currentTimeSec: p.getCurrentTime(),
                durationSec: p.getDuration(),
              });
            }
          },
          onError: () => {
            if (currentVideo.current) cbs.current.onError(currentVideo.current);
          },
        },
      });

      // Report playback position once per second for the live scrub bar.
      reportTimer = setInterval(() => {
        const p = playerRef.current;
        if (!p || !currentVideo.current) return;
        const duration = p.getDuration();
        if (!duration) return;
        cbs.current.onReport({
          status: "playing",
          currentTimeSec: p.getCurrentTime(),
          durationSec: duration,
        });
      }, 1000);
    });

    return () => {
      cancelled = true;
      clearInterval(reportTimer);
      playerRef.current?.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load a new video whenever the now-playing videoId changes.
  useEffect(() => {
    if (!videoId || !playerRef.current) return;
    if (currentVideo.current === videoId) return;
    currentVideo.current = videoId;
    playerRef.current.loadVideoById(videoId);
  }, [videoId]);

  return <div className="h-full w-full" ref={containerRef} />;
});
