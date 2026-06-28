"use client";

// The big-screen host view. The LEFT is the video stage (the authoritative
// playback surface) with a slim progress/fullscreen footer — unchanged. The
// RIGHT is a phone-sized, full-height panel with the SAME Search / Faves /
// Recent / Queue tabs (and reactions) as the remote, so you can browse and
// queue songs while the video keeps playing. Fullscreen hides the right panel
// and fills the screen with the video.

import { AnimatePresence, motion } from "framer-motion";
import { signIn, signOut, useSession } from "next-auth/react";
import { useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FavoritesTab,
  PasswordGate,
  QueueTab,
  RecentTab,
  RoomMissing,
  SearchTab,
  SFX_BUTTONS,
  SignInPrompt,
  TAB_LABELS,
  type Tab,
} from "@/components/SongTabs";
import { PlayerHandle, YouTubePlayer } from "@/components/YouTubePlayer";
import { formatTime } from "@/lib/format";
import { playSfx, unlockAudio } from "@/lib/sfx";
import { getSocket } from "@/lib/socket";
import type { SfxName } from "@/lib/types";
import { useRoom } from "@/lib/useRoom";
import { useSongLibrary } from "@/lib/useSongLibrary";

// Safari still exposes fullscreen only under webkit-prefixed names.
type FsDocument = Document & {
  webkitFullscreenElement?: Element;
  webkitExitFullscreen?: () => Promise<void>;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void>;
};

// Speaker icon that matches the volume level: 0 waves + ✕ when muted, one wave
// when quiet, two when loud. Inherits color via currentColor.
function VolumeIcon({
  level,
  className,
}: {
  level: number;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor" />
      {level === 0 ? (
        <g
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          fill="none"
        >
          <path d="M16 9.5l5 5" />
          <path d="M21 9.5l-5 5" />
        </g>
      ) : (
        <g
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          fill="none"
        >
          <path d="M15.5 9a4 4 0 0 1 0 6" />
          {level >= 50 && <path d="M18.5 6.5a8 8 0 0 1 0 11" />}
        </g>
      )}
    </svg>
  );
}

export default function HostPage() {
  const code = String(useParams().room || "").toUpperCase();
  const { data: session } = useSession();
  const signedIn = !!session?.user?.id;

  // Password resolution. The CREATOR comes from the landing "Start a room" flow,
  // which stashed the password in sessionStorage — they create the room. Anyone
  // else opening /host/CODE is a CO-HOST: they must enter the room's password
  // (and never overwrite it). A typed URL for a room that doesn't exist is
  // simply "not found".
  const [password, setPassword] = useState("");
  const [isCreator, setIsCreator] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    const stored = sessionStorage.getItem(`host-pw-${code}`);
    setIsCreator(!!stored);
    setPassword(stored ?? "");
    setResolved(true);
  }, [code]);

  const {
    state,
    livePlayer,
    connected,
    joined,
    joinError,
    addSong,
    removeSong,
    reorder,
    sendCommand,
    sendSfx,
    reportState,
    notifyEnded,
  } = useRoom(code, "host", {
    password,
    create: isCreator,
    userId: session?.user?.id,
  });

  // Remember a co-host password that worked so a reload re-joins seamlessly.
  useEffect(() => {
    if (joined && password) sessionStorage.setItem(`host-pw-${code}`, password);
  }, [joined, password, code]);

  // Favorites (★), add-to-queue + "added" toast — shared with remote. The singer
  // name is applied automatically (Google name when signed in, else "Guest").
  const { starred, favorite, add, addMany, toast } = useSongLibrary({
    addSong,
    signedIn,
    sessionName: session?.user?.name,
  });

  const [tab, setTab] = useState<Tab>("queue");
  const [showReactions, setShowReactions] = useState(false);
  const playerRef = useRef<PlayerHandle>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [blockedId, setBlockedId] = useState<string | null>(null);
  // TV volume (0–100), local to this screen. Persisted so a reload keeps it.
  const [volume, setVolume] = useState(100);
  // Mirror of `volume` for the [] -dep unlock effect (reads the latest value
  // when the first user gesture fires, without re-subscribing).
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    setJoinUrl(`${window.location.origin}/r/${code}`);
    const saved = Number(localStorage.getItem("host-volume"));
    if (Number.isFinite(saved) && saved >= 0 && saved <= 100) setVolume(saved);
  }, [code]);

  const changeVolume = (v: number) => {
    setVolume(v);
    playerRef.current?.setVolume(v);
    localStorage.setItem("host-volume", String(v));
  };

  // Execute transport commands that remotes (or our own Queue-tab buttons) send,
  // relayed by the server back to this host socket.
  useEffect(() => {
    const socket = getSocket();
    const onCommand = (cmd: { cmd: string; valueSec?: number }) => {
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
    // Play sound effects triggered from remotes (or the host) on the TV.
    const onSfx = ({ name }: { name: SfxName }) => playSfx(name);

    socket.on("player:command", onCommand);
    socket.on("sfx:play", onSfx);

    // Unlock the audio context on the first interaction so SFX can play later
    // without a gesture (browsers start it suspended). Also re-apply the TV
    // volume here: autoplay starts the video muted, and an un-mute only "takes"
    // once there's been a user gesture — this first tap/keypress is it.
    const unlock = () => {
      unlockAudio();
      playerRef.current?.setVolume(volumeRef.current);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    return () => {
      socket.off("player:command", onCommand);
      socket.off("sfx:play", onSfx);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const nowPlaying = state?.nowPlaying ?? null;
  const queue = state?.queue ?? [];
  const player = livePlayer ?? state?.playerState ?? null;
  const progress = useMemo(() => {
    if (!player || !player.durationSec) return 0;
    return Math.min(100, (player.currentTimeSec / player.durationSec) * 100);
  }, [player]);

  // Sync a newly-opened host to an in-progress song. We capture the live
  // position/play-state from the FIRST room snapshot we receive (the join
  // snapshot); once our player is actually playing, we seek there and match
  // play/pause so this screen lines up with any hosts already running. Decided
  // once — if we open into an idle room, later songs just play from the start.
  const syncTargetRef = useRef<{
    positionSec: number;
    paused: boolean;
    capturedAt: number;
  } | null>(null);
  const syncDecidedRef = useRef(false);
  useEffect(() => {
    if (syncDecidedRef.current || !state) return;
    syncDecidedRef.current = true;
    const ps = state.playerState;
    if (state.nowPlaying && ps.status !== "idle") {
      syncTargetRef.current = {
        positionSec: ps.currentTimeSec,
        paused: ps.status === "paused",
        capturedAt: Date.now(),
      };
    }
  }, [state]);

  const handlePlayerReady = () => {
    playerRef.current?.setVolume(volume);
    const t = syncTargetRef.current;
    if (!t) return;
    syncTargetRef.current = null;
    // Advance the target by however long we spent loading so we land on the
    // other hosts' *current* position (skip the catch-up when it's paused).
    const pos = t.paused
      ? t.positionSec
      : t.positionSec + (Date.now() - t.capturedAt) / 1000;
    playerRef.current?.seek(pos);
    if (t.paused) playerRef.current?.pause();
  };

  // A non-embeddable video errored — auto-skip after a short notice.
  useEffect(() => {
    if (!blockedId || !nowPlaying || nowPlaying.videoId !== blockedId) return;
    const t = setTimeout(() => {
      sendCommand({ cmd: "skip" });
      setBlockedId(null);
    }, 3500);
    return () => clearTimeout(t);
  }, [blockedId, nowPlaying, sendCommand]);

  // Fullscreen the whole host page. Includes the webkit-prefixed calls Safari
  // still requires.
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

  // Co-host gating (the creator skips this — they make the room). Wait for the
  // sessionStorage check first so we don't flash a gate at the creator.
  if (!resolved) {
    return <main className="h-screen bg-black" />;
  }
  if (!isCreator) {
    if (joinError === "not_found") return <RoomMissing code={code} />;
    if (!joined) {
      return (
        <PasswordGate
          code={code}
          showError={attempted && joinError === "bad_password"}
          onSubmit={(p) => {
            setAttempted(true);
            setPassword(p);
          }}
        />
      );
    }
  }

  return (
    // Stacked on narrow screens (phone host: video on top, panel below);
    // side-by-side on wide screens (laptop host).
    <main className="flex h-screen flex-col overflow-hidden bg-black lg:flex-row">
      {/* LEFT: video stage + slim footer. */}
      <div
        className={`flex flex-col overflow-hidden lg:min-h-0 lg:flex-1 ${
          isFullscreen ? "flex-1" : "shrink-0"
        }`}
      >
        <div
          className={`relative w-full bg-black lg:flex-1 ${
            isFullscreen
              ? "flex-1"
              : "aspect-video max-h-[60vh] lg:aspect-auto lg:max-h-none"
          }`}
        >
          {nowPlaying ? (
            <YouTubePlayer
              ref={playerRef}
              videoId={nowPlaying.videoId}
              onReport={reportState}
              onEnded={() => notifyEnded(nowPlaying?.id)}
              onError={(id) => setBlockedId(id)}
              onReady={handlePlayerReady}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="text-7xl">🎤</div>
              <h2 className="mt-6 text-3xl font-bold text-white/80">
                Queue’s empty
              </h2>
              <p className="mt-2 text-white/40">
                Scan the code, or use the Search tab, to add a song →
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

          {/* In fullscreen the right panel is gone, so surface the join code,
              password, and the single next song here instead. */}
          {isFullscreen && (
            <div className="flex shrink-0 items-center gap-4">
              <div className="text-center">
                <div className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                  Code
                </div>
                <div className="text-base font-black tracking-[0.2em] text-white">
                  {code}
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                  Pass
                </div>
                <div className="bg-gradient-to-r from-fuchsia-500 to-pink-500 bg-clip-text text-base font-black tracking-[0.2em] text-transparent">
                  {password || "····"}
                </div>
              </div>
              {queue[0] && (
                <div className="max-w-[220px] border-l border-white/10 pl-4 text-left">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                    Next up
                  </div>
                  <div className="truncate text-sm font-medium">
                    {queue[0].title}
                  </div>
                  <div className="truncate text-xs text-fuchsia-300">
                    🎙️ {queue[0].singer}
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            className={`flex items-center gap-3 ${
              isFullscreen ? "w-1/4" : "w-1/3"
            }`}
          >
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

          {/* TV volume — local to this screen. Hidden in fullscreen (where the
              footer is reserved for the join code / next-up). */}
          {!isFullscreen && (
            <div className="flex w-36 shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => changeVolume(volume === 0 ? 100 : 0)}
                className="shrink-0 text-white/60 transition hover:text-white"
                aria-label={volume === 0 ? "Unmute" : "Mute"}
              >
                <VolumeIcon level={volume} className="h-5 w-5" />
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                onChange={(e) => changeVolume(Number(e.target.value))}
                aria-label="Volume"
                className="h-1 flex-1 cursor-pointer accent-fuchsia-500"
              />
            </div>
          )}
          <button
            type="button"
            onClick={toggleFullscreen}
            className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold transition hover:bg-white/20 active:scale-95"
            aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
          >
            {isFullscreen ? "⤢" : "⛶"}
          </button>
        </footer>
      </div>

      {/* RIGHT: phone-sized remote panel (full height). Hidden in fullscreen. */}
      {!isFullscreen && (
        <aside className="relative flex w-full flex-1 flex-col overflow-hidden border-t border-white/10 bg-[#0a0a0f] lg:w-[400px] lg:flex-none lg:border-l lg:border-t-0">
          {/* Header: who's singing + sign in */}
          <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
            <span className="min-w-0 truncate text-sm text-white/60">
              {signedIn
                ? `🎤 ${session?.user?.name ?? ""}`
                : "Singing as Guest — sign in to use your name"}
            </span>
            {signedIn ? (
              <button
                type="button"
                onClick={() => signOut()}
                className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/60 active:scale-95"
                title={`Signed in as ${session?.user?.name ?? ""}`}
              >
                Sign out
              </button>
            ) : (
              <button
                type="button"
                onClick={() => signIn("google")}
                className="shrink-0 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black active:scale-95"
              >
                Sign in
              </button>
            )}
          </header>

          {/* Join strip: QR + code + password so guests can hop on. */}
          <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
            {joinUrl && (
              <QRCodeSVG
                value={joinUrl}
                size={72}
                bgColor="#ffffff"
                fgColor="#0a0a0f"
                className="shrink-0 rounded border-2 border-white"
              />
            )}
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                Room · scan to join
              </div>
              <div className="text-2xl font-black tracking-[0.25em] text-white">
                {code}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                  Pass
                </span>
                <span className="bg-gradient-to-r from-fuchsia-500 to-pink-500 bg-clip-text text-lg font-black tracking-[0.25em] text-transparent">
                  {password || "····"}
                </span>
              </div>
            </div>
            <span
              className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                connected ? "bg-emerald-400" : "bg-white/30"
              }`}
              title={connected ? "Connected" : "Disconnected"}
            />
          </div>

          {/* Tabs */}
          <nav className="flex border-b border-white/10">
            {(["search", "favorites", "recent", "queue"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 py-3 text-xs font-semibold transition ${
                  tab === t
                    ? "border-b-2 border-fuchsia-400 text-white"
                    : "text-white/40"
                }`}
              >
                {TAB_LABELS[t]}
                {t === "queue" ? ` ${queue.length}` : ""}
              </button>
            ))}
          </nav>

          {/* Tab content. Search has its own fixed bar + scrolling results and
              stays mounted (hidden) so results persist across tab switches. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              className={
                tab === "search" ? "flex min-h-0 flex-1 flex-col" : "hidden"
              }
            >
              <SearchTab
                onAdd={add}
                onAddMany={addMany}
                onStar={favorite}
                starred={starred}
              />
            </div>
            {tab !== "search" && (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {tab === "favorites" &&
                  (signedIn ? (
                    <FavoritesTab onAdd={add} onStar={favorite} starred={starred} />
                  ) : (
                    <SignInPrompt message="Sign in with Google to save and see your favorite songs." />
                  ))}
                {tab === "recent" && (
                  <RecentTab
                    history={state?.history ?? []}
                    onAdd={add}
                    onStar={favorite}
                    starred={starred}
                  />
                )}
                {tab === "queue" && (
                  <QueueTab
                    queue={queue}
                    nowPlaying={nowPlaying}
                    player={player}
                    onRemove={removeSong}
                    onReorder={reorder}
                    onCommand={sendCommand}
                    onStar={favorite}
                    starred={starred}
                  />
                )}
              </div>
            )}
          </div>

          {/* Reactions — reveals the sound-effect options (play on the TV). */}
          <div className="absolute bottom-5 right-5 z-30 flex flex-col items-end gap-2">
            <AnimatePresence>
              {showReactions && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.9 }}
                  className="flex flex-col gap-1 rounded-2xl border border-white/10 bg-[#1a1a22] p-2 shadow-xl"
                >
                  {SFX_BUTTONS.map((b) => (
                    <button
                      key={b.name}
                      type="button"
                      onClick={() => sendSfx(b.name)}
                      className="flex items-center gap-2 rounded-xl px-3 py-2 text-left transition active:scale-95 active:bg-white/10"
                    >
                      <span className="text-2xl">{b.emoji}</span>
                      <span className="text-sm font-medium">{b.label}</span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
            <button
              type="button"
              onClick={() => setShowReactions((v) => !v)}
              aria-label="Reactions"
              className="flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-[#1a1a22] text-2xl shadow-lg shadow-black/40 transition active:scale-95"
            >
              {showReactions ? "✕" : "🎉"}
            </button>
          </div>
        </aside>
      )}

      {/* Transient "added" confirmation */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="pointer-events-none fixed inset-x-0 bottom-6 z-20 mx-auto w-fit max-w-[90%] rounded-full bg-emerald-500 px-5 py-2.5 text-center text-sm font-semibold text-black shadow-lg"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
