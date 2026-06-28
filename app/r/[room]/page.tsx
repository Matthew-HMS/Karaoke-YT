"use client";

// The phone remote. Guests search YouTube (or paste a link), add songs with
// their name, see the queue, and control playback (play/pause/skip + an
// instant seek bar — the headline "jump to any part, no download" feature).
// Signing in with Google unlocks personal favorites; "Recent" is this room's
// own play history (live from room state).

import { AnimatePresence, motion } from "framer-motion";
import { signIn, signOut, useSession } from "next-auth/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
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
  } = useRoom(code, "remote", { password: pw, userId: session?.user?.id });

  // Remember a password that worked.
  useEffect(() => {
    if (joined && pw) sessionStorage.setItem(`guest-pw-${code}`, pw);
  }, [joined, pw, code]);

  const [tab, setTab] = useState<Tab>("search");
  const [showReactions, setShowReactions] = useState(false);

  // Favorites (★), add-to-queue + "added" toast — shared with host. The singer
  // name is applied automatically (Google name when signed in, else "Guest").
  const { starred, favorite, add, addMany, toast } = useSongLibrary({
    addSong,
    signedIn,
    sessionName: session?.user?.name,
  });

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
            {t === "queue" && state ? ` ${state.queue.length}` : ""}
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
                queue={state?.queue ?? []}
                nowPlaying={state?.nowPlaying ?? null}
                player={livePlayer ?? state?.playerState ?? null}
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

      {/* Reactions — a button that reveals the sound-effect options (play on TV). */}
      <div className="fixed bottom-5 right-5 z-30 flex flex-col items-end gap-2">
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
    </main>
  );
}

