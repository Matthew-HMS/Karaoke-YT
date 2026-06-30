"use client";

// The phone remote. Guests search YouTube (or paste a link), add songs with
// their name, see the queue, and control playback (play/pause/skip + an
// instant seek bar — the headline "jump to any part, no download" feature).
// Signing in with Google unlocks personal favorites; "Recent" is this room's
// own play history (live from room state).

import { AnimatePresence, motion } from "framer-motion";
import { signIn, signOut, useSession } from "next-auth/react";
import { useParams } from "next/navigation";
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
import { ControlsMenu } from "@/components/ControlsMenu";
import { useMicPitch } from "@/lib/useMicPitch";
import { useRoom } from "@/lib/useRoom";
import { useSongLibrary } from "@/lib/useSongLibrary";

export default function RemotePage() {
  const code = String(useParams().room || "").toUpperCase();
  const { data: session } = useSession();
  const signedIn = !!session?.user?.id;

  // Join password (entered once, remembered for this tab so a reload re-joins).
  const [pw, setPw] = useState("");
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    setPw(sessionStorage.getItem(`guest-pw-${code}`) || "");
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
    reportPitch,
    showTarget,
    setShowTarget,
    spinWheel,
  } = useRoom(code, "remote", { password: pw, userId: session?.user?.id });

  // Seed the random-singer wheel with the people who've queued songs.
  const queuedSingers = useMemo(() => {
    const all = [
      ...(state?.queue ?? []).map((q) => q.singer),
      ...(state?.nowPlaying ? [state.nowPlaying.singer] : []),
    ];
    return [...new Set(all.map((s) => s?.trim()).filter(Boolean))] as string[];
  }, [state]);

  // Remember a password that worked.
  useEffect(() => {
    if (joined && pw) sessionStorage.setItem(`guest-pw-${code}`, pw);
  }, [joined, pw, code]);

  const [tab, setTab] = useState<Tab>("search");

  // Favorites (★), add-to-queue + "added" toast — shared with host. The singer
  // name (persisted) doubles as the identity stamped on pitch samples, so the
  // TV ribbon/score can name a guest even when they're not signed in.
  const { name, saveName, starred, favorite, add, addMany, toast } =
    useSongLibrary({
      addSong,
      signedIn,
      sessionName: session?.user?.name,
    });

  // Mic pitch capture lives at the page level (not inside the menu panel) so it
  // keeps running when the panel is closed mid-song.
  const mic = useMicPitch({ singer: name.trim() || "Guest", onSample: reportPitch });

  // Auto-stop the mic when the song ends (now-playing changes or the queue
  // empties), so each take is one song — the singer re-arms Sing for the next.
  // Read `mic` via a ref so this only re-runs on a song change, not every render.
  const micRef = useRef(mic);
  useEffect(() => {
    micRef.current = mic;
  });
  const songId = state?.nowPlaying?.id;
  const prevSongId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevSongId.current !== undefined && prevSongId.current !== songId) {
      if (micRef.current.active) micRef.current.stop();
    }
    prevSongId.current = songId;
  }, [songId]);

  // Gate the remote behind room-exists + password checks.
  if (joinError === "not_found") return <RoomMissing code={code} />;
  if (!joined) {
    return (
      <PasswordGate
        code={code}
        showError={attempted && joinError === "bad_password"}
        onSubmit={(p) => {
          setAttempted(true);
          setPw(p);
        }}
      />
    );
  }

  return (
    <main className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden">
      {/* Top bar: brand, connection, sign in. The name field lives in the
          scrollable area below (so it scrolls away and isn't mistaken for the
          search box); the tabs stay pinned here. */}
      <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-[#0a0a0f] px-4 py-3">
        <span className="text-lg font-black tracking-tight">SingAlong</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-xs text-white/40">
            <span
              className={`h-2 w-2 rounded-full ${
                connected ? "bg-emerald-400" : "bg-white/30"
              }`}
            />
            Room {code}
          </span>
          {signedIn ? (
            <button
              type="button"
              onClick={() => signOut()}
              className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/60 active:scale-95"
              title={`Signed in as ${session?.user?.name ?? ""}`}
            >
              Sign out
            </button>
          ) : (
            <button
              type="button"
              onClick={() => signIn("google")}
              className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-black active:scale-95"
            >
              Sign in
            </button>
          )}
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex border-b border-white/10 bg-[#0a0a0f]">
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

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Search has its own fixed bar + scrolling results; it stays mounted
            (just hidden) so results persist when you switch tabs and back. */}
        <div
          className={tab === "search" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
        >
          <SearchTab
            onAdd={add}
            onAddMany={addMany}
            onStar={favorite}
            starred={starred}
            signedIn={signedIn}
          />
        </div>
        {tab !== "search" && (
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
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
                queue={state?.queue ?? []}
                nowPlaying={state?.nowPlaying ?? null}
                player={livePlayer ?? state?.playerState ?? null}
                onRemove={removeSong}
                onReorder={reorder}
                onCommand={sendCommand}
                onAdd={add}
                onStar={favorite}
                starred={starred}
                signedIn={signedIn}
              />
            )}
          </div>
        )}
      </div>

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

      {/* One floating menu: Sing (mic + name) + Target toggle + Reactions.
          Shared with the host so both surfaces are identical. */}
      <ControlsMenu
        mic={mic}
        name={name}
        onNameChange={saveName}
        showTarget={showTarget}
        onToggleTarget={() => setShowTarget(!showTarget)}
        onSfx={sendSfx}
        onSpin={spinWheel}
        suggestedNames={queuedSingers}
      />
    </main>
  );
}

