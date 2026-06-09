"use client";

// The big-screen host view: plays the current song via the YouTube IFrame
// player, shows now-playing + up-next, and displays a QR code so guests can
// join from their phones. It is the authoritative playback source and relays
// transport commands from remotes onto the iframe.

import { AnimatePresence, motion } from "framer-motion";
import { useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PlayerHandle, YouTubePlayer } from "@/components/YouTubePlayer";
import { formatTime } from "@/lib/format";
import { getSocket } from "@/lib/socket";
import { useRoom } from "@/lib/useRoom";

// Safari still exposes fullscreen only under webkit-prefixed names.
type FsDocument = Document & {
  webkitFullscreenElement?: Element;
  webkitExitFullscreen?: () => Promise<void>;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

export default function HostPage() {
  const code = String(useParams().room || "").toUpperCase();
  const { state, livePlayer, sendCommand, reportState, notifyEnded } =
    useRoom(code, "host");
  const playerRef = useRef<PlayerHandle>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [blockedId, setBlockedId] = useState<string | null>(null);

  useEffect(() => {
    setJoinUrl(`${window.location.origin}/r/${code}`);
  }, [code]);

  // Execute transport commands that remotes send (relayed by the server).
  useEffect(() => {
    const socket = getSocket();
    const onCommand = (cmd: {
      cmd: string;
      valueSec?: number;
    }) => {
      const p = playerRef.current;
      if (!p) return;
      if (cmd.cmd === "play") p.play();
      else if (cmd.cmd === "pause") p.pause();
      else if (cmd.cmd === "restart") p.restart();
      else if (cmd.cmd === "seek" && typeof cmd.valueSec === "number")
        p.seek(cmd.valueSec);
      // "skip" advances the queue server-side; the new videoId arrives via
      // room:state and the player loads it automatically.
    };
    socket.on("player:command", onCommand);
    return () => {
      socket.off("player:command", onCommand);
    };
  }, []);

  const nowPlaying = state?.nowPlaying ?? null;
  const queue = state?.queue ?? [];
  const player = livePlayer ?? state?.playerState ?? null;
  const progress = useMemo(() => {
    if (!player || !player.durationSec) return 0;
    return Math.min(100, (player.currentTimeSec / player.durationSec) * 100);
  }, [player]);

  // A non-embeddable video errored — auto-skip after a short notice.
  useEffect(() => {
    if (!blockedId || !nowPlaying || nowPlaying.videoId !== blockedId) return;
    const t = setTimeout(() => {
      sendCommand({ cmd: "skip" });
      setBlockedId(null);
    }, 3500);
    return () => clearTimeout(t);
  }, [blockedId, nowPlaying, sendCommand]);

  // Fullscreen the whole host page (keeps the QR + up-next visible). Includes
  // the webkit-prefixed calls Safari still requires.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(
        !!(document.fullscreenElement ||
          (document as FsDocument).webkitFullscreenElement)
      );
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const toggleFullscreen = () => {
    const doc = document as FsDocument;
    const el = document.documentElement as FsElement;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
    } else {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
    }
  };

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-black">
      <div className="flex flex-1 overflow-hidden">
        {/* Video stage */}
        <div className="relative flex-1 bg-black">
          {nowPlaying ? (
            <YouTubePlayer
              ref={playerRef}
              videoId={nowPlaying.videoId}
              onReport={reportState}
              onEnded={notifyEnded}
              onError={(id) => setBlockedId(id)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="text-7xl">🎤</div>
              <h2 className="mt-6 text-3xl font-bold text-white/80">
                Queue’s empty
              </h2>
              <p className="mt-2 text-white/40">
                Scan the code to add the first song →
              </p>
            </div>
          )}

          {blockedId && nowPlaying?.videoId === blockedId && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 text-center">
              <p className="text-2xl font-bold text-amber-300">
                This video can’t be embedded
              </p>
              <p className="mt-2 text-white/60">Skipping to the next song…</p>
            </div>
          )}
        </div>

        {/* Sidebar: join code + up next */}
        <aside className="flex w-[340px] flex-col gap-6 border-l border-white/10 bg-[#0a0a0f] p-6">
          <div className="rounded-2xl bg-white/5 p-5 text-center">
            <div className="text-sm font-medium uppercase tracking-wide text-white/40">
              Join at
            </div>
            <div className="mt-2 flex justify-center">
              {joinUrl && (
                <QRCodeSVG
                  value={joinUrl}
                  size={150}
                  bgColor="#ffffff"
                  fgColor="#0a0a0f"
                  className="rounded-lg border-4 border-white"
                />
              )}
            </div>
            <div className="mt-3 text-4xl font-black tracking-[0.3em] text-white">
              {code}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto no-scrollbar">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/40">
              Up next · {queue.length}
            </h3>
            <ul className="space-y-2">
              <AnimatePresence initial={false}>
                {queue.map((item, i) => (
                  <motion.li
                    key={item.id}
                    layout
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-3 rounded-xl bg-white/5 p-2"
                  >
                    <span className="w-5 text-center text-sm text-white/30">
                      {i + 1}
                    </span>
                    <img
                      src={item.thumbnail}
                      alt=""
                      className="h-10 w-16 rounded object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {item.title}
                      </div>
                      <div className="truncate text-xs text-fuchsia-300">
                        {item.singer}
                      </div>
                    </div>
                  </motion.li>
                ))}
              </AnimatePresence>
              {queue.length === 0 && (
                <li className="text-sm text-white/30">Nothing queued yet.</li>
              )}
            </ul>
          </div>
        </aside>
      </div>

      {/* Now playing bar */}
      <footer className="flex items-center gap-4 border-t border-white/10 bg-[#0a0a0f] px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold">
            {nowPlaying ? nowPlaying.title : "—"}
          </div>
          {nowPlaying && (
            <div className="text-sm text-fuchsia-300">
              🎙️ {nowPlaying.singer}
            </div>
          )}
        </div>
        <div className="flex w-1/2 items-center gap-3">
          <span className="text-xs tabular-nums text-white/50">
            {formatTime(player?.currentTimeSec ?? 0)}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-pink-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-white/50">
            {formatTime(player?.durationSec ?? 0)}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold transition hover:bg-white/20 active:scale-95"
          aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
        >
          {isFullscreen ? "⤢" : "⛶"}
        </button>
      </footer>
    </main>
  );
}
