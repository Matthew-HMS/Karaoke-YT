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
  PlayerTab,
  RecentTab,
  RoomMissing,
  SearchTab,
  SignInPrompt,
  TAB_LABELS,
  type Tab,
} from "@/components/SongTabs";
import { ControlsMenu, VolumeIcon } from "@/components/ControlsMenu";
import { SettingsOverlay } from "@/components/SettingsOverlay";
import { HostTour, type TourStep } from "@/components/HostTour";
import { PitchRibbon } from "@/components/PitchRibbon";
import { ScoreCard } from "@/components/ScoreCard";
import { SpinnerWheel } from "@/components/SpinnerWheel";
import { WhatsNewModal } from "@/components/WhatsNewModal";
import { PlayerHandle, YouTubePlayer } from "@/components/YouTubePlayer";
import type { SingerScore } from "@/lib/pitch";
import { formatTime } from "@/lib/format";
import { playSfx, unlockAudio } from "@/lib/sfx";
import { getSocket } from "@/lib/socket";
import type { SfxName } from "@/lib/types";
import { useMicPitch } from "@/lib/useMicPitch";
import { useReferenceContour } from "@/lib/useReferenceContour";
import { useRoom } from "@/lib/useRoom";
import { useSongLibrary } from "@/lib/useSongLibrary";
import { useWakeLock } from "@/lib/useWakeLock";
import { usePrefetchLyrics } from "@/lib/usePrefetchLyrics";
import {
  clearOnboarded,
  getLastSeenVersion,
  hasOnboarded,
  setLastSeenVersion,
  setOnboarded,
} from "@/lib/onboarding";
import { APP_VERSION, CHANGELOG, isNewerVersion } from "@/lib/version";

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
    reportPitch,
    showTarget,
    setShowTarget,
    wheelSpin,
    spinWheel,
    wheelNames,
    setWheelNames,
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
  const { name, saveName, starred, favorite, add, addMany, toast } =
    useSongLibrary({
      addSong,
      signedIn,
      sessionName: session?.user?.name,
    });

  const [tab, setTab] = useState<Tab>("search");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const playerRef = useRef<PlayerHandle>(null);

  // The host can be a phone too, so it gets the same mic-pitch capture as a
  // remote (page-level so closing the menu doesn't stop a take).
  const mic = useMicPitch({ singer: name.trim() || "Guest", onSample: reportPitch });
  const [joinUrl, setJoinUrl] = useState("");
  const [qrEnlarged, setQrEnlarged] = useState(false);
  const [blockedId, setBlockedId] = useState<string | null>(null);
  // End-of-song score card: the PitchRibbon hands up the final per-singer
  // ranking when a song ends, and we show it for a few seconds. A timer ref
  // lets a quick next-song dismiss the previous card cleanly.
  const [scoreCard, setScoreCard] = useState<SingerScore[] | null>(null);
  const scoreCardTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showScoreCard = (results: SingerScore[]) => {
    setScoreCard(results);
    clearTimeout(scoreCardTimer.current);
    scoreCardTimer.current = setTimeout(() => setScoreCard(null), 8000);
  };
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
    const onCommand = (cmd: {
      cmd: string;
      valueSec?: number;
      value?: number;
    }) => {
      const p = playerRef.current;
      if (!p) return;
      if (cmd.cmd === "play") p.play();
      else if (cmd.cmd === "pause") p.pause();
      else if (cmd.cmd === "restart") p.restart();
      else if (cmd.cmd === "seek" && typeof cmd.valueSec === "number")
        p.seek(cmd.valueSec);
      else if (cmd.cmd === "volume" && typeof cmd.value === "number") {
        // A remote set the TV volume — apply it and mirror it into our local
        // slider + storage so the footer/menu reflect the new level.
        p.setVolume(cmd.value);
        setVolume(cmd.value);
        localStorage.setItem("host-volume", String(cmd.value));
      }
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

  // Seed the random-singer wheel with the people who've queued songs.
  const queuedSingers = useMemo(() => {
    const all = [
      ...(state?.queue ?? []).map((q) => q.singer),
      ...(state?.nowPlaying ? [state.nowPlaying.singer] : []),
    ];
    return [...new Set(all.map((s) => s?.trim()).filter(Boolean))] as string[];
  }, [state]);

  // Warm the lyrics cache for the current song + next few queued ones, so the
  // Lyrics tab is instant. The host owns playback and is always open, so its
  // prefetch fills the shared server cache that remotes read from too.
  usePrefetchLyrics(nowPlaying, queue);

  // Keep the screen awake while a song is playing — a phone-as-host that dims
  // and locks would pause the YouTube embed. Idle (empty queue) lets it sleep.
  useWakeLock(!!nowPlaying);
  const player = livePlayer ?? state?.playerState ?? null;

  // Fetch the song's reference pitch contour (the karaoke target line). Polls
  // while it's still generating on the server; null until ready for this song.
  const { contour: reference, status: referenceStatus } = useReferenceContour(
    nowPlaying?.videoId
  );

  // Auto-stop the host's mic when the song ends — one take per song, matching
  // the remote. Read `mic` via a ref so this only re-runs on a song change.
  const micRef = useRef(mic);
  useEffect(() => {
    micRef.current = mic;
  });
  const songId = nowPlaying?.id;
  const prevSongId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevSongId.current !== undefined && prevSongId.current !== songId) {
      if (micRef.current.active) micRef.current.stop();
    }
    prevSongId.current = songId;
  }, [songId]);
  // Footer scrub bar. The player only reports its position once a second, so
  // while someone is dragging we show THEIR position right away and hand
  // control back to the reported time shortly after they let go.
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  const scrubTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(scrubTimer.current), []);
  const durationSec = player?.durationSec ?? 0;
  const positionSec = scrubSec ?? player?.currentTimeSec ?? 0;
  // Seeking goes through the room (not straight to our own player) so every
  // host screen jumps together — same path as the remote's seek bar.
  const seekTo = (sec: number) => {
    setScrubSec(sec);
    sendCommand({ cmd: "seek", valueSec: sec });
    clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => setScrubSec(null), 1200);
  };
  const progress = useMemo(() => {
    if (!durationSec) return 0;
    return Math.min(100, (positionSec / durationSec) * 100);
  }, [positionSec, durationSec]);

  // Detect a wiped session: room state lives in memory on the server, so a
  // restart/redeploy clears the queue + now-playing. If we were disconnected
  // mid-session and then reconnect into an empty room, surface that instead of
  // silently flipping to the bland "Queue's empty" screen.
  const [sessionReset, setSessionReset] = useState(false);
  const hadContentRef = useRef(false);
  const expectResetRef = useRef(false);
  useEffect(() => {
    // Arm the detector only if we lose the connection while something was going.
    if (!connected && hadContentRef.current) expectResetRef.current = true;
  }, [connected]);
  useEffect(() => {
    if (!state) return;
    const hasContent = !!(state.nowPlaying || state.queue.length > 0);
    if (hasContent) {
      hadContentRef.current = true;
      expectResetRef.current = false;
      if (sessionReset) setSessionReset(false);
    } else if (connected && expectResetRef.current) {
      // Reconnected and the room came back empty → the server restarted.
      setSessionReset(true);
      expectResetRef.current = false;
      hadContentRef.current = false;
    }
  }, [state, connected, sessionReset]);

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

  // Draggable split (lg only): width of the right panel in px. The video stage
  // is flex-1, so shrinking the panel widens the video and vice-versa. Persisted
  // so the host's preferred layout survives reloads. Clamped in the drag handler.
  const PANEL_MIN = 320;
  const PANEL_MAX = 760;
  const [panelWidth, setPanelWidth] = useState(400);
  useEffect(() => {
    const saved = Number(localStorage.getItem("hostPanelWidth"));
    if (saved) setPanelWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, saved)));
  }, []);
  const startPanelDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - ev.clientX));
      setPanelWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setPanelWidth((w) => {
        localStorage.setItem("hostPanelWidth", String(w));
        return w;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

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
    // `screen.orientation.lock` isn't in the DOM lib types and is Android-only.
    const orientation = window.screen?.orientation as
      | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
      | undefined;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      orientation?.unlock?.();
      (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
    } else {
      const req = (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
      // On a phone the video is width-limited in portrait, so fullscreen alone
      // doesn't make it bigger — force landscape so it fills the long edge. The
      // lock only works once fullscreen is active (and only on phones); it's a
      // no-op / rejects on desktop and iOS, which we ignore.
      Promise.resolve(req)
        .then(() => orientation?.lock?.("landscape"))
        .catch(() => {});
    }
  };

  // Onboarding: a first-run spotlight tour and a "what's new" modal. Both are
  // per-device (localStorage) and host-only. The room UI (with the tour's
  // `data-tour` anchors) is on screen once the co-host gate is cleared.
  const roomReady = resolved && (isCreator || joined);
  const [showTour, setShowTour] = useState(false);
  const [whatsNew, setWhatsNew] = useState<typeof CHANGELOG>([]);

  // First-run tour steps. Each points at a `[data-tour="..."]` anchor; some
  // switch tabs first so the anchor is on screen. Memoized (stable identity) so
  // the tour's measurement loop isn't disrupted by the host's frequent renders.
  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        selector: '[data-tour="join"]',
        title: "Invite singers 📱",
        body: "Guests scan this QR code — or type the room code and password — to join from their phones.",
      },
      {
        selector: '[data-tour="stage"]',
        title: "The stage 📺",
        body: "Whatever's queued plays here on the big screen. This is what everyone watches and sings along to.",
      },
      {
        selector: '[data-tour="tabs"]',
        title: "Find songs 🔍",
        body: "Search for songs, or revisit your Favorites and Recents. Tap Player to control the queue and see more.",
        onEnter: () => setTab("search"),
      },
      {
        selector: '[data-tour="playertabs"]',
        title: "Queue, Lyrics & Related 🎶",
        body: "The Player tab has three views: what's up Next, synced Lyrics for the current song, and Related songs to add.",
        onEnter: () => setTab("queue"),
      },
      {
        selector: '[data-tour="controls"]',
        title: "Sing & more 🎤",
        body: "Open this menu to score your singing with the mic, show the target pitch line, set TV volume, spin the random-singer wheel, and fire off reactions.",
      },
      {
        selector: '[data-tour="fullscreen"]',
        title: "Go full screen ⛶",
        body: "Fill the TV with the video. Tap here again anytime to exit.",
      },
    ],
    [],
  );
  const decidedRef = useRef(false);
  useEffect(() => {
    if (!roomReady || decidedRef.current) return;
    if (!hasOnboarded()) {
      // The tour points at the right panel, which is hidden in fullscreen — wait
      // until the host exits before starting it.
      if (isFullscreen) return;
      decidedRef.current = true;
      setShowTour(true);
      return;
    }
    decidedRef.current = true;
    const last = getLastSeenVersion();
    if (!last) {
      // Onboarded before versioning existed — adopt the current version rather
      // than retroactively showing every changelog entry.
      setLastSeenVersion(APP_VERSION);
      return;
    }
    const entries = CHANGELOG.filter((e) => isNewerVersion(e.version, last));
    if (entries.length) setWhatsNew(entries);
  }, [roomReady, isFullscreen]);

  const finishTour = () => {
    setShowTour(false);
    setOnboarded();
    // Stamp the current version too, so a brand-new host doesn't immediately get
    // the "what's new" modal for features the tour just covered.
    setLastSeenVersion(APP_VERSION);
  };
  const replayTour = () => {
    clearOnboarded();
    setShowTour(true);
  };
  const dismissWhatsNew = () => {
    setWhatsNew([]);
    setLastSeenVersion(APP_VERSION);
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
    // Stacked on narrow screens (phone host: video pinned on top, panel below);
    // side-by-side on wide screens (laptop host). On a phone the video stays
    // fixed while the panel beneath it scrolls on its own — the header and join
    // strip scroll away so the song list gets more room, with the tab bar
    // sticking to the top. On lg it's a fixed-height split with an
    // internally-scrolling side panel.
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-black lg:h-screen lg:flex-row">
      {/* LEFT: video stage + slim footer. */}
      <div
        className={`flex flex-col overflow-hidden lg:min-h-0 lg:flex-1 ${
          isFullscreen ? "flex-1" : "shrink-0"
        }`}
      >
        <div
          data-tour="stage"
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
          ) : sessionReset ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="text-7xl">🔄</div>
              <h2 className="mt-6 text-3xl font-bold text-white/80">
                Session was reset
              </h2>
              <p className="mt-2 max-w-md text-white/40">
                The server restarted, so the queue and current song were cleared.
                Your favorites are safe — just add songs to start again.
              </p>
              <button
                type="button"
                onClick={() => setSessionReset(false)}
                className="mt-6 rounded-xl bg-white/10 px-5 py-2.5 text-sm font-semibold active:scale-95"
              >
                Got it
              </button>
            </div>
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

          {/* Live pitch ribbon + per-singer scores from singing remotes. The
              `key` remounts it per song so scores reset; on unmount it hands the
              final ranking up for the score card. */}
          {nowPlaying && (
            <PitchRibbon
              key={nowPlaying.id}
              onFinalize={showScoreCard}
              referenceMidis={reference?.midis ?? null}
              referenceFps={reference?.fps ?? 12}
              showTarget={showTarget}
              songTimeSec={player?.currentTimeSec ?? 0}
              playing={player?.status === "playing"}
            />
          )}

          {/* Target line is on but its pitch reference couldn't be generated
              (e.g. the audio download is bot-walled) — tell the host instead of
              silently showing no line. */}
          {nowPlaying && showTarget && referenceStatus === "unavailable" && (
            <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-center text-xs text-white/60 backdrop-blur-sm">
              Target pitch line unavailable for this song right now.
            </div>
          )}

          {/* End-of-song score card (over the stage, above the ribbon). */}
          <ScoreCard results={scoreCard} onDismiss={() => setScoreCard(null)} />
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
              {formatTime(positionSec)}
            </span>
            {/* Draggable progress: the slim bar doubles as a scrub bar, like
                the seek slider on the now-playing card. A transparent range
                input sits on top of the painted track so tap-to-jump, drag and
                arrow keys all work without restyling native slider internals.
                It's inert until a song with a known duration is loaded. */}
            <div className="group relative h-4 flex-1">
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-pink-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {durationSec > 0 && (
                <div
                  className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  style={{ left: `${progress}%` }}
                />
              )}
              <input
                type="range"
                aria-label="Seek"
                min={0}
                max={Math.max(durationSec, 1)}
                step={1}
                value={Math.min(positionSec, durationSec || 1)}
                disabled={durationSec === 0}
                onChange={(e) => seekTo(Number(e.target.value))}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
              />
            </div>
            <span className="text-xs tabular-nums text-white/50">
              {formatTime(durationSec)}
            </span>
          </div>

          {/* TV volume — local to this screen (also in the Controls menu).
              Hidden in fullscreen (the footer is reserved for join code /
              next-up there). The slider length shrinks on smaller screens,
              like the progress bar. */}
          {!isFullscreen && (
            <div className="flex w-20 shrink-0 items-center gap-2 sm:w-28 lg:w-36">
              <button
                type="button"
                onClick={() => changeVolume(volume === 0 ? 100 : 0)}
                className="shrink-0 text-white/60 transition hover:text-white active:scale-95"
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
                className="h-1 min-w-0 flex-1 cursor-pointer accent-fuchsia-500"
              />
            </div>
          )}

          <button
            type="button"
            data-tour="fullscreen"
            onClick={toggleFullscreen}
            className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold transition hover:bg-white/20 active:scale-95"
            aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
          >
            {isFullscreen ? "⤢" : "⛶"}
          </button>
        </footer>
      </div>

      {/* Drag handle to resize the split (lg only). Widening the panel shrinks
          the video and vice-versa. */}
      {!isFullscreen && (
        <div
          onPointerDown={startPanelDrag}
          className="hidden w-1.5 shrink-0 cursor-col-resize bg-white/10 transition-colors hover:bg-fuchsia-400/60 lg:block"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize"
        />
      )}

      {/* RIGHT: phone-sized remote panel (full height). Hidden — but kept
          mounted — in fullscreen, so toggling fullscreen doesn't remount the
          panel and refetch the recommendation list. Inline `display` wins over
          the `flex` class. */}
      <aside
          style={{
            "--panel-w": `${panelWidth}px`,
            display: isFullscreen ? "none" : undefined,
          } as React.CSSProperties}
          className="no-scrollbar relative flex w-full flex-1 flex-col overflow-y-auto border-t border-white/10 bg-[#0a0a0f] lg:w-[var(--panel-w)] lg:flex-none lg:overflow-hidden lg:border-l lg:border-t-0"
        >
          {/* Header: who's singing + sign in */}
          <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
            <span className="min-w-0 truncate text-sm text-white/60">
              {signedIn
                ? `🎤 ${session?.user?.name ?? ""}`
                : "Singing as Guest — sign in to use your name"}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {signedIn ? (
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/60 active:scale-95"
                  title={`Signed in as ${session?.user?.name ?? ""}`}
                >
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => signIn("google")}
                  className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black active:scale-95"
                >
                  Sign in
                </button>
              )}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-2xl leading-none text-white/60 transition hover:text-white active:scale-95"
                title="Settings"
                aria-label="Settings"
              >
                ⚙
              </button>
            </div>
          </header>

          {/* Join strip: QR + code + password so guests can hop on. */}
          <div
            data-tour="join"
            className="flex items-center gap-3 border-b border-white/10 px-4 py-3"
          >
            {joinUrl && (
              <button
                type="button"
                onClick={() => setQrEnlarged(true)}
                className="shrink-0"
                title="Tap to enlarge"
              >
                <QRCodeSVG
                  value={joinUrl}
                  size={72}
                  bgColor="#ffffff"
                  fgColor="#0a0a0f"
                  className="rounded border-2 border-white"
                />
              </button>
            )}
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                Scan to join
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                  Room
                </span>
                <span className="text-2xl font-black tracking-[0.25em] text-white">
                  {code}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-white/40">
                  Password
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

          {/* Tap the join QR to blow it up as a centered overlay; tap the
              backdrop to dismiss. */}
          {qrEnlarged && joinUrl && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
              onClick={() => setQrEnlarged(false)}
            >
              <div
                className="rounded-2xl bg-white p-6"
                onClick={(e) => e.stopPropagation()}
              >
                <QRCodeSVG
                  value={joinUrl}
                  size={Math.min(360, typeof window !== "undefined" ? window.innerWidth - 96 : 360)}
                  bgColor="#ffffff"
                  fgColor="#0a0a0f"
                />
              </div>
            </div>
          )}

          {/* Tabs — stick to the top while the page scrolls on a phone, so you
              can switch tabs without scrolling back up. */}
          <nav
            data-tour="tabs"
            className="sticky top-0 z-10 flex border-b border-white/10 bg-[#0a0a0f] lg:static"
          >
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
              </button>
            ))}
          </nav>

          {/* Tab content. Search has its own fixed bar + scrolling results and
              stays mounted (hidden) so results persist across tab switches. */}
          <div className="flex flex-col lg:min-h-0 lg:flex-1">
            <div
              className={
                tab === "search"
                  ? "flex flex-col lg:min-h-0 lg:flex-1"
                  : "hidden"
              }
            >
              <SearchTab
                onAdd={add}
                onAddMany={addMany}
                onStar={favorite}
                starred={starred}
                signedIn={signedIn}
                pageScroll
              />
            </div>
            {tab !== "search" && (
              <div className="no-scrollbar px-4 py-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
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
                  <PlayerTab
                    queue={queue}
                    nowPlaying={nowPlaying}
                    history={state?.history ?? []}
                    player={player}
                    onRemove={removeSong}
                    onReorder={reorder}
                    onCommand={sendCommand}
                    onAdd={add}
                    onStar={favorite}
                    starred={starred}
                    signedIn={signedIn}
                    isHost
                  />
                )}
              </div>
            )}
          </div>

          {/* ⚙ Settings: AI key + feature toggles + the Target-line toggle. */}
          <SettingsOverlay
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            showTarget={showTarget}
            onToggleTarget={(v) => setShowTarget(v)}
            onReplayTour={replayTour}
          />

          {/* Same floating menu as the phone (the host can be a phone too):
              Sing + Reactions. Anchored to this side panel. */}
          <ControlsMenu
            mic={mic}
            name={name}
            onNameChange={saveName}
            volume={volume}
            onVolumeChange={changeVolume}
            onSfx={sendSfx}
            onSpin={spinWheel}
            wheelNames={wheelNames}
            onWheelNamesChange={setWheelNames}
            suggestedNames={queuedSingers}
            containerClassName="fixed bottom-5 right-5 lg:absolute"
            dataTour="controls"
          />
        </aside>

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

      {/* Random-singer wheel — full-screen so it shows over the video even in
          fullscreen. The TV plays the drumroll + applause; phones stay silent. */}
      <SpinnerWheel
        spin={wheelSpin}
        onSpinStart={() => playSfx("drumroll")}
        onLand={() => playSfx("applause")}
      />

      {/* First-run guided tour + post-update "what's new" (host-only, per-device). */}
      {showTour && <HostTour steps={tourSteps} onDone={finishTour} />}
      <WhatsNewModal entries={whatsNew} onDismiss={dismissWhatsNew} />
    </main>
  );
}
