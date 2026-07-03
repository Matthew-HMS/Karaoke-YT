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
  useState,
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
  getPlayerState: () => number;
  setVolume: (volume: number) => void;
  mute: () => void;
  unMute: () => void;
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
  setVolume: (volume: number) => void;
};

type Props = {
  videoId: string | null;
  onReport: (state: PlayerState) => void;
  onEnded: () => void;
  onError: (videoId: string) => void;
  // Fires once the player is actually playing (and therefore seekable), so the
  // host can sync a late-opened screen to the in-progress position.
  onReady?: () => void;
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
  { videoId, onReport, onEnded, onError, onReady },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const currentVideo = useRef<string | null>(null);
  // Fire onReady only on the first time playback actually starts.
  const readyFired = useRef(false);
  // Whether the CURRENT video has ever reached PLAYING. Reset on each new load.
  // Before the first play, a PAUSED/cued state is a stalled autoplay (common on
  // flaky wifi, where YouTube parks on its big play button) — not an intentional
  // pause — so we keep nudging it and don't broadcast "paused" to the room.
  const startedRef = useRef(false);
  // Mirror of startedRef as state, purely to toggle the click-blocking overlay:
  // BEFORE the video has started we let taps reach the iframe so the user can
  // hit YouTube's own play button if autoplay was blocked (a real in-iframe user
  // gesture — the only thing that starts a cross-origin embed the browser
  // refused to autoplay). AFTER it's playing the overlay re-engages to protect
  // room sync (no tap-to-pause on just this screen).
  const [started, setStarted] = useState(false);
  // When the current video was loaded, and whether we've already retried it
  // muted. Autoplay-with-sound is attempted first; if the video is still parked
  // on the play button after a short grace, the browser blocked sounded
  // autoplay, so we retry MUTED (always permitted). Reset on each new load.
  const loadedAtRef = useRef(0);
  const mutedTriedRef = useRef(false);
  // True when the video still hasn't started even after the muted retry — i.e.
  // it's region-restricted on THIS screen (playable where it was queued, blocked
  // here). We only show a local notice; we never skip, so hosts in a region that
  // CAN play it keep going. Clears on a new load or if it recovers and plays.
  const [regionBlocked, setRegionBlocked] = useState(false);
  // Keep latest callbacks without re-initializing the player.
  const cbs = useRef({ onReport, onEnded, onError, onReady });
  cbs.current = { onReport, onEnded, onError, onReady };

  useImperativeHandle(ref, () => ({
    play: () => playerRef.current?.playVideo(),
    pause: () => playerRef.current?.pauseVideo(),
    seek: (sec) => playerRef.current?.seekTo(sec, true),
    restart: () => playerRef.current?.seekTo(0, true),
    // 0–100. The player keeps its volume across loadVideoById, so this sticks
    // for the whole session once set. Autoplay makes the browser start the
    // player MUTED, so explicitly unMute() (or mute() at 0) — setVolume alone
    // wouldn't clear that mute flag, leaving it silent at volume 100.
    setVolume: (volume) => {
      const p = playerRef.current;
      if (!p) return;
      if (volume > 0) p.unMute();
      else p.mute();
      p.setVolume(volume);
    },
  }));

  // Initialize the player once.
  useEffect(() => {
    let cancelled = false;
    let reportTimer: ReturnType<typeof setInterval>;

    const targetNode = document.createElement("div");
    if (containerRef.current) {
      containerRef.current.appendChild(targetNode);
    }

    loadYouTubeApi().then(() => {
      if (cancelled || !containerRef.current || !window.YT) return;

      playerRef.current = new window.YT.Player(targetNode, {
        videoId: videoId || undefined,
        width: "100%",
        height: "100%",
        playerVars: {
          // Try to autoplay WITH sound. Browsers that allow it (e.g. Chrome for
          // a site you interact with often) start with audio immediately. Those
          // that block sounded autoplay (Safari, stricter settings) park on the
          // play button — the watchdog below detects that and retries MUTED,
          // which is always permitted, so playback still starts. The host then
          // un-mutes on the first user gesture (see host page `unlock`).
          autoplay: 1,
          controls: 0,
          rel: 0,
          modestbranding: 1,
          origin: window.location.origin,
          enablejsapi: 1
        },
        events: {
          onReady: () => {
            if (videoId && currentVideo.current !== videoId) {
              currentVideo.current = videoId;
              startedRef.current = false;
              setStarted(false);
              setRegionBlocked(false);
              loadedAtRef.current = Date.now();
              mutedTriedRef.current = false;
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
              startedRef.current = true;
              setStarted(true);
              setRegionBlocked(false);
              cbs.current.onReport({
                status: "playing",
                currentTimeSec: p.getCurrentTime(),
                durationSec: p.getDuration(),
              });
              if (!readyFired.current) {
                readyFired.current = true;
                cbs.current.onReady?.();
              }
            } else if (e.data === YT.PlayerState.PAUSED) {
              // A PAUSED before the video ever started is a stalled autoplay,
              // not a real pause — nudge it instead of telling the room we're
              // paused (which would flip everyone's play button + stop sync).
              if (!startedRef.current) {
                p.playVideo();
                return;
              }
              cbs.current.onReport({
                status: "paused",
                currentTimeSec: p.getCurrentTime(),
                durationSec: p.getDuration(),
              });
            } else if (e.data === 5 || e.data === -1) {
              // CUED (5) / UNSTARTED (-1): autoplay didn't kick in — common on
              // flaky wifi, where the video loads but never starts until the
              // user clicks play. Nudge it so the host doesn't have to.
              p.playVideo();
            }
          },
          onError: (e: { data: number }) => {
            console.error("YouTube Player Error Code:", e.data);
            // 101, 150 = "Video cannot be embedded by request of the owner"
            // We only want to skip when we know for sure it's blocked.
            if (currentVideo.current && (e.data === 101 || e.data === 150)) {
              cbs.current.onError(currentVideo.current);
            }
          },
        },
      });

      // Report playback position once per second for the live scrub bar — but
      // ONLY while actually playing. Otherwise this would clobber the "paused"
      // status (from onStateChange) with "playing" a second later, flipping the
      // remote's play/pause button so pause couldn't be resumed.
      reportTimer = setInterval(() => {
        const p = playerRef.current;
        if (!p || !currentVideo.current || !window.YT) return;
        const state = p.getPlayerState();
        // Watchdog for stalled autoplay: a flaky connection can leave the
        // video parked at CUED (5), UNSTARTED (-1), or — after a buffering
        // stall — PAUSED (2) before it ever started, all of which show
        // YouTube's big play button. Keep nudging it to play so it recovers on
        // its own without anyone clicking the video. Once it HAS started,
        // PAUSED is honored as a real pause.
        if (state === 5 || state === -1 || (state === 2 && !startedRef.current)) {
          const elapsed = Date.now() - loadedAtRef.current;
          // Still parked after a short grace → the browser blocked sounded
          // autoplay. Retry MUTED (universally allowed) so it plays anyway; the
          // host un-mutes on the first user gesture.
          if (!mutedTriedRef.current && elapsed > 2000) {
            mutedTriedRef.current = true;
            p.mute();
          }
          // Still not playing even MUTED after a long grace → this video is
          // region-restricted on this screen. Show a local notice (no skip, so
          // other regions keep playing). Self-clears if it ever starts.
          if (mutedTriedRef.current && elapsed > 8000) {
            setRegionBlocked(true);
          }
          p.playVideo();
          return;
        }
        if (state !== window.YT.PlayerState.PLAYING) return;
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
      try {
        playerRef.current?.destroy();
      } catch {
        // Ignore errors during destroy
      }
      if (containerRef.current) {
        try {
          containerRef.current.innerHTML = "";
        } catch {}
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load a new video whenever the now-playing videoId changes.
  useEffect(() => {
    if (!videoId || !playerRef.current) return;
    if (currentVideo.current === videoId) return;
    currentVideo.current = videoId;
    startedRef.current = false;
    setStarted(false);
    setRegionBlocked(false);
    loadedAtRef.current = Date.now();
    mutedTriedRef.current = false;
    playerRef.current.loadVideoById(videoId);
  }, [videoId]);

  return (
    <div className="relative h-full w-full">
      <div className="h-full w-full" ref={containerRef} />
      {/* Transparent overlay that swallows clicks/taps so YouTube's own
          play/pause (native controls, and tap-to-pause) can't be used once
          playing — that path changes only THIS screen and never reaches the
          other hosts, breaking sync. With it blocked, all playback goes through
          our own controls, which broadcast to every host.
          BEFORE the video has started we make it click-through
          (pointer-events-none) so a user whose browser refused to autoplay can
          tap YouTube's own play button to start it — the only reliable way to
          begin a cross-origin embed the browser blocked. Once it's PLAYING the
          overlay re-engages to protect sync. */}
      <div
        className={`absolute inset-0 z-10 ${started ? "" : "pointer-events-none"}`}
        aria-hidden
      />

      {/* Region-restriction notice: this specific video won't play on THIS
          screen (blocked in this country) even after a muted retry. We show it
          locally and never skip, so anyone in a region that CAN play it keeps
          singing. */}
      {regionBlocked && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 px-6 text-center">
          <p className="text-2xl font-bold text-amber-300">
            Not available in your region
          </p>
          <p className="mt-2 max-w-md text-white/60">
            YouTube blocks this video where you are. Others in a supported region
            can still play it — or pick a different upload of the song.
          </p>
        </div>
      )}
    </div>
  );
});
