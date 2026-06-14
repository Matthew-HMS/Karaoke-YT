"use client";

// The phone remote. Guests search YouTube (or paste a link), add songs with
// their name, see the queue, and control playback (play/pause/skip + an
// instant seek bar — the headline "jump to any part, no download" feature).
// Signing in with Google unlocks personal favorites; "Recent" is this room's
// own play history (live from room state).

import { AnimatePresence, motion, Reorder, useDragControls } from "framer-motion";
import { signIn, signOut, useSession } from "next-auth/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { isValidPassword, normalizePassword } from "@/lib/code";
import { formatTime } from "@/lib/format";
import { useRoom } from "@/lib/useRoom";
import type { QueueItem, SfxName } from "@/lib/types";

type SearchResult = {
  videoId: string;
  title: string;
  thumbnail: string;
  durationSec: number;
};

type Tab = "search" | "favorites" | "recent" | "queue";

const TAB_LABELS: Record<Tab, string> = {
  search: "Search",
  favorites: "★ Faves",
  recent: "Recent",
  queue: "Queue",
};

// Reaction buttons → play a sound effect on the TV (host).
const SFX_BUTTONS: { name: SfxName; emoji: string; label: string }[] = [
  { name: "applause", emoji: "👏", label: "Applause" },
  { name: "whistle", emoji: "😗", label: "Whistle" },
  { name: "airhorn", emoji: "📯", label: "Airhorn" },
  { name: "tada", emoji: "🎉", label: "Ta-da" },
  { name: "drumroll", emoji: "🥁", label: "Drumroll" },
  { name: "sadtrombone", emoji: "📉", label: "Sad trombone" },
];

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
  const [name, setName] = useState("");
  // Local "just starred" set for instant ★ feedback across tabs.
  const [starred, setStarred] = useState<Set<string>>(new Set());
  // Transient "Added ✓" confirmation (so we don't have to jump to the Queue).
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  // Singer name: a previously-typed name wins; otherwise default to the
  // signed-in Google name. Always editable and persisted.
  useEffect(() => {
    const saved = localStorage.getItem("singer-name");
    if (saved) setName(saved);
    else if (session?.user?.name) setName(session.user.name);
  }, [session?.user?.name]);

  const saveName = (n: string) => {
    setName(n);
    localStorage.setItem("singer-name", n);
  };

  const add = useCallback(
    (r: SearchResult) => {
      addSong({
        videoId: r.videoId,
        title: r.title,
        thumbnail: r.thumbnail,
        durationSec: r.durationSec,
        singer: name.trim() || "Guest",
      });
      // Stay on the current tab so you can keep adding; just confirm.
      const short = r.title.length > 40 ? r.title.slice(0, 40) + "…" : r.title;
      flashToast(`✓ Added “${short}” to the queue`);
    },
    [addSong, name, flashToast]
  );

  // Add many at once (a playlist) with a single confirmation toast.
  const addMany = useCallback(
    (songs: SearchResult[]) => {
      const singer = name.trim() || "Guest";
      songs.forEach((s) =>
        addSong({
          videoId: s.videoId,
          title: s.title,
          thumbnail: s.thumbnail,
          durationSec: s.durationSec,
          singer,
        })
      );
      flashToast(`✓ Added ${songs.length} songs to the queue`);
    },
    [addSong, name, flashToast]
  );

  // Toggle a song in the signed-in user's favorites (prompts sign-in if guest):
  // tapping a ☆ stars it, tapping the ★ again un-stars it.
  const favorite = useCallback(
    (song: SearchResult) => {
      if (!signedIn) {
        signIn("google");
        return;
      }
      const isStarred = starred.has(song.videoId);
      setStarred((prev) => {
        const next = new Set(prev);
        if (isStarred) next.delete(song.videoId);
        else next.add(song.videoId);
        return next;
      });
      if (isStarred) {
        fetch(`/api/favorites?videoId=${encodeURIComponent(song.videoId)}`, {
          method: "DELETE",
        });
      } else {
        fetch("/api/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(song),
        });
      }
    },
    [signedIn, starred]
  );

  // Seed the starred set from the server so ★/☆ is accurate across tabs (and
  // un-starring works for songs favorited in a previous session). Clear on
  // sign-out.
  useEffect(() => {
    if (!signedIn) {
      setStarred(new Set());
      return;
    }
    let active = true;
    fetch("/api/favorites")
      .then((r) => (r.ok ? r.json() : { results: [] }))
      .then((d) => {
        if (active) {
          setStarred(
            new Set((d.results ?? []).map((s: SearchResult) => s.videoId))
          );
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [signedIn]);

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
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#0a0a0f]/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <span className="text-lg font-black tracking-tight">SingAlong</span>
          <span className="flex items-center gap-2 text-xs text-white/40">
            <span
              className={`h-2 w-2 rounded-full ${
                connected ? "bg-emerald-400" : "bg-white/30"
              }`}
            />
            Room {code}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => saveName(e.target.value)}
            placeholder="Your name (shown on the big screen)"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-fuchsia-400"
          />
          {signedIn ? (
            <button
              type="button"
              onClick={() => signOut()}
              className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 text-xs text-white/60 active:scale-95"
              title={`Signed in as ${session?.user?.name ?? ""}`}
            >
              Sign out
            </button>
          ) : (
            <button
              type="button"
              onClick={() => signIn("google")}
              className="shrink-0 rounded-lg bg-white px-3 text-xs font-semibold text-black active:scale-95"
            >
              Sign in
            </button>
          )}
        </div>
      </header>

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
            {t === "queue" && state ? ` ${state.queue.length}` : ""}
          </button>
        ))}
      </nav>

      <div className="flex-1 px-4 py-4">
        {tab === "search" && (
          <SearchTab
            onAdd={add}
            onAddMany={addMany}
            onStar={favorite}
            starred={starred}
          />
        )}
        {tab === "favorites" &&
          (signedIn ? (
            <FavoritesTab onAdd={add} onStar={favorite} starred={starred} />
          ) : (
            <SignInPrompt
              message="Sign in with Google to save and see your favorite songs."
            />
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

// Shown when the entered code has no active host room.
function RoomMissing({ code }: { code: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="text-5xl">🤷</div>
      <h1 className="mt-4 text-2xl font-bold">Room not found</h1>
      <p className="mt-2 text-white/50">
        No active room with code <span className="font-mono font-bold">{code}</span>.
        Check the code, or ask the host to start the room.
      </p>
      <a
        href="/"
        className="mt-6 rounded-xl bg-white/10 px-5 py-2.5 font-semibold active:scale-95"
      >
        ← Back
      </a>
    </main>
  );
}

// Password prompt before a guest can enter a room.
function PasswordGate({
  code,
  showError,
  onSubmit,
}: {
  code: string;
  showError: boolean;
  onSubmit: (pw: string) => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-xs text-center">
        <div className="text-5xl">🔒</div>
        <h1 className="mt-4 text-2xl font-bold">Join room {code}</h1>
        <p className="mt-2 text-sm text-white/50">
          Enter the 4-letter password shown on the TV.
        </p>
        <input
          value={pw}
          onChange={(e) => setPw(normalizePassword(e.target.value))}
          onKeyDown={(e) =>
            e.key === "Enter" && isValidPassword(pw) && onSubmit(pw)
          }
          autoFocus
          autoCapitalize="characters"
          placeholder="····"
          className="mt-5 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-3xl font-black tracking-[0.4em] uppercase outline-none focus:border-fuchsia-400"
        />
        {showError && (
          <p className="mt-2 text-sm text-amber-400">Incorrect password.</p>
        )}
        <button
          type="button"
          onClick={() => isValidPassword(pw) && onSubmit(pw)}
          disabled={!isValidPassword(pw)}
          className="mt-4 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 py-3 font-bold disabled:opacity-40 active:scale-[0.99]"
        >
          Join
        </button>
      </div>
    </main>
  );
}

function SignInPrompt({ message }: { message: string }) {
  return (
    <div className="rounded-2xl bg-white/5 p-6 text-center">
      <p className="text-sm text-white/60">{message}</p>
      <button
        type="button"
        onClick={() => signIn("google")}
        className="mt-4 rounded-xl bg-white px-5 py-2.5 text-sm font-bold text-black active:scale-95"
      >
        Sign in with Google
      </button>
    </div>
  );
}

// A reusable row: thumbnail + title + optional star + Add.
function SongRow({
  song,
  onAdd,
  onStar,
  starred,
  trailing,
}: {
  song: SearchResult;
  onAdd: (r: SearchResult) => void;
  onStar?: (r: SearchResult) => void;
  starred?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl bg-white/5 p-2">
      <img src={song.thumbnail} alt="" className="h-12 w-20 rounded object-cover" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm font-medium">{song.title}</div>
        {song.durationSec > 0 && (
          <div className="text-xs text-white/40">
            {formatTime(song.durationSec)}
          </div>
        )}
      </div>
      {trailing}
      {onStar && (
        <button
          type="button"
          onClick={() => onStar(song)}
          className={`shrink-0 px-2 text-lg active:scale-90 ${
            starred ? "text-amber-300" : "text-white/30"
          }`}
          aria-label="Save to favorites"
        >
          {starred ? "★" : "☆"}
        </button>
      )}
      <button
        type="button"
        onClick={() => onAdd(song)}
        className="shrink-0 rounded-lg bg-fuchsia-500 px-3 py-2 text-sm font-bold active:scale-95"
      >
        Add
      </button>
    </li>
  );
}

function SearchTab({
  onAdd,
  onAddMany,
  onStar,
  starred,
}: {
  onAdd: (r: SearchResult) => void;
  onAddMany: (rs: SearchResult[]) => void;
  onStar: (r: SearchResult) => void;
  starred: Set<string>;
}) {
  const [q, setQ] = useState("");
  const [karaokeOnly, setKaraokeOnly] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [limit, setLimit] = useState(20);
  const [lastQuery, setLastQuery] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const looksLikeUrl = /youtu\.be\/|youtube\.com\//.test(q);
  // A real playlist link (has list=, not an auto-generated radio/mix).
  const playlistMatch = q.match(/[?&]list=([\w-]+)/);
  const isPlaylist = !!playlistMatch && !/^(RD|UL)/.test(playlistMatch[1]);

  const runSearch = useCallback(
    async (query: string, lim: number, kOnly: boolean, append = false) => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&karaokeOnly=${
            kOnly ? "1" : "0"
          }&limit=${lim}`
        );
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 429 || `${data.error}`.includes("429")) {
            throw new Error(
              "YouTube search limit hit — wait a minute and try again. (Pasting a link still works.)"
            );
          }
          throw new Error(data.error || "Search failed");
        }
        if (append) {
          // Append only NEW videos, keeping existing rows in place so the list
          // doesn't jump/reorder on "Load more".
          setResults((prev) => {
            const have = new Set(prev.map((r) => r.videoId));
            return [
              ...prev,
              ...(data.results as SearchResult[]).filter(
                (r) => !have.has(r.videoId)
              ),
            ];
          });
        } else {
          setResults(data.results);
        }
        setLastQuery(query);
        setLimit(lim);
        setHasMore((data.results?.length ?? 0) >= lim);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
        if (!append) setResults([]);
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    []
  );

  const submit = () => runSearch(q, 20, karaokeOnly);
  const toggleKaraoke = (k: boolean) => {
    setKaraokeOnly(k);
    if (lastQuery) runSearch(lastQuery, 20, k);
  };
  const loadMore = () => runSearch(lastQuery, limit + 20, karaokeOnly, true);

  const addPlaylist = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn’t read playlist");
      onAddMany(data.results);
      setQ("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t read playlist");
    } finally {
      setLoading(false);
    }
  };

  const addPastedLink = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/parse-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Invalid link");
      onAdd(data.result);
      setQ("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid link");
    } finally {
      setLoading(false);
    }
  };

  // Pin the user's favorites to the top of results (stable sort).
  const displayed = [...results].sort(
    (a, b) => Number(starred.has(b.videoId)) - Number(starred.has(a.videoId))
  );

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !looksLikeUrl) submit();
          }}
          enterKeyHint="search"
          placeholder="Search songs, or paste a YouTube link"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-fuchsia-400"
        />
        {!looksLikeUrl && (
          <button
            type="button"
            onClick={submit}
            disabled={loading || !q.trim()}
            className="shrink-0 rounded-xl bg-fuchsia-500 px-4 font-bold disabled:opacity-40 active:scale-95"
          >
            Search
          </button>
        )}
      </div>

      {looksLikeUrl ? (
        <button
          type="button"
          onClick={isPlaylist ? addPlaylist : addPastedLink}
          disabled={loading}
          className="mt-3 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 py-3 font-bold disabled:opacity-50"
        >
          {loading
            ? "Adding…"
            : isPlaylist
            ? "➕ Add whole playlist"
            : "➕ Add this link"}
        </button>
      ) : (
        <label className="mt-3 flex items-center gap-2 text-sm text-white/60">
          <input
            type="checkbox"
            checked={karaokeOnly}
            onChange={(e) => toggleKaraoke(e.target.checked)}
            className="h-4 w-4 accent-fuchsia-500"
          />
          Karaoke versions only
        </label>
      )}

      {error && <p className="mt-3 text-sm text-amber-400">{error}</p>}
      {loading && !looksLikeUrl && (
        <p className="mt-3 text-sm text-white/40">Searching…</p>
      )}

      <ul className="mt-4 space-y-2">
        {displayed.map((r) => (
          <SongRow
            key={r.videoId}
            song={r}
            onAdd={onAdd}
            onStar={onStar}
            starred={starred.has(r.videoId)}
          />
        ))}
      </ul>

      {hasMore && !looksLikeUrl && displayed.length > 0 && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-3 w-full rounded-xl bg-white/10 py-3 font-semibold active:scale-95 disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

// The signed-in user's favorites (fetched from the per-user API). Uses the same
// star toggle as everywhere else — tapping ★ un-stars and the row drops out.
function FavoritesTab({
  onAdd,
  onStar,
  starred,
}: {
  onAdd: (r: SearchResult) => void;
  onStar: (r: SearchResult) => void;
  starred: Set<string>;
}) {
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<"added" | "plays">("added");

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/favorites?sort=${sort}`)
      .then((r) => r.json())
      .then((d) => active && setItems(d.results ?? []))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [sort]);

  // Only show songs that are still starred, so un-starring removes them live.
  const visible = items.filter((i) => starred.has(i.videoId));

  const addRandom = () => {
    if (visible.length === 0) return;
    onAdd(visible[Math.floor(Math.random() * visible.length)]);
  };

  const FAV_SORTS: { key: "added" | "plays"; label: string }[] = [
    { key: "added", label: "Newest added" },
    { key: "plays", label: "Most played" },
  ];

  return (
    <div>
      <div className="mb-3 flex gap-1">
        {FAV_SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSort(s.key)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${
              sort === s.key
                ? "bg-fuchsia-500 text-white"
                : "bg-white/5 text-white/50"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-white/40">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-white/30">
          No favorites yet. Tap ☆ on any song to save it.
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={addRandom}
            className="mb-3 w-full rounded-xl bg-gradient-to-r from-amber-400 to-fuchsia-500 py-3 font-bold text-black active:scale-[0.99]"
          >
            🎲 Surprise me — add a random favorite
          </button>
          <ul className="space-y-2">
        {visible.map((r) => (
          <SongRow
            key={r.videoId}
            song={r}
            onAdd={onAdd}
            onStar={onStar}
            starred={starred.has(r.videoId)}
          />
        ))}
          </ul>
        </>
      )}
    </div>
  );
}

// This room's own play history, live from room state (most-recent first).
function RecentTab({
  history,
  onAdd,
  onStar,
  starred,
}: {
  history: QueueItem[];
  onAdd: (r: SearchResult) => void;
  onStar: (r: SearchResult) => void;
  starred: Set<string>;
}) {
  if (history.length === 0)
    return (
      <p className="text-sm text-white/30">
        Nothing’s been played in this room yet.
      </p>
    );

  return (
    <ul className="space-y-2">
      {history.map((item, i) => (
        <SongRow
          key={`${item.videoId}-${i}`}
          song={item}
          onAdd={onAdd}
          onStar={onStar}
          starred={starred.has(item.videoId)}
        />
      ))}
    </ul>
  );
}

function QueueTab({
  queue,
  nowPlaying,
  player,
  onRemove,
  onReorder,
  onCommand,
  onStar,
  starred,
}: {
  queue: QueueItem[];
  nowPlaying: QueueItem | null;
  player: { status: string; currentTimeSec: number; durationSec: number } | null;
  onRemove: (id: string) => void;
  onReorder: (order: string[]) => void;
  onCommand: ReturnType<typeof useRoom>["sendCommand"];
  onStar: (r: SearchResult) => void;
  starred: Set<string>;
}) {
  const isPlaying = player?.status === "playing";
  const dur = player?.durationSec ?? 0;
  const cur = player?.currentTimeSec ?? 0;

  // Local copy so a drag feels instant; we only re-sync from the server when the
  // SET of songs changes (someone added/removed, or a song finished) — not on
  // our own reorder echoing back, which would fight the drag.
  const [items, setItems] = useState<QueueItem[]>(queue);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const sameMembership =
      queue.length === itemsRef.current.length &&
      queue.every((q) => itemsRef.current.some((it) => it.id === q.id));
    if (!sameMembership) setItems(queue);
  }, [queue]);

  // Commit the final order to the server when a drag ends.
  const commitOrder = () => onReorder(itemsRef.current.map((it) => it.id));

  return (
    <div>
      {nowPlaying ? (
        <div className="rounded-2xl bg-gradient-to-br from-fuchsia-500/20 to-pink-500/10 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">
              Now playing
            </div>
            <button
              type="button"
              onClick={() => onStar(nowPlaying)}
              className={`-mt-1 text-2xl leading-none active:scale-90 ${
                starred.has(nowPlaying.videoId)
                  ? "text-amber-300"
                  : "text-white/40"
              }`}
              aria-label="Save to favorites"
            >
              {starred.has(nowPlaying.videoId) ? "★" : "☆"}
            </button>
          </div>
          <div className="mt-1 font-bold">{nowPlaying.title}</div>
          <div className="text-sm text-white/60">🎙️ {nowPlaying.singer}</div>

          {/* Instant seek bar */}
          <div className="mt-3">
            <input
              type="range"
              aria-label="Seek"
              min={0}
              max={Math.max(dur, 1)}
              value={Math.min(cur, dur || 1)}
              onChange={(e) =>
                onCommand({ cmd: "seek", valueSec: Number(e.target.value) })
              }
              className="w-full accent-fuchsia-500"
            />
            <div className="flex justify-between text-xs text-white/40">
              <span>{formatTime(cur)}</span>
              <span>{formatTime(dur)}</span>
            </div>
          </div>

          {/* Transport */}
          <div className="mt-3 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => onCommand({ cmd: "restart" })}
              className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold active:scale-95"
            >
              ⏮ Restart
            </button>
            <button
              type="button"
              onClick={() => onCommand({ cmd: isPlaying ? "pause" : "play" })}
              className="rounded-full bg-white px-6 py-2 text-sm font-bold text-black active:scale-95"
            >
              {isPlaying ? "⏸ Pause" : "▶ Play"}
            </button>
            <button
              type="button"
              onClick={() => onCommand({ cmd: "skip" })}
              className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold active:scale-95"
            >
              ⏭ Skip
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl bg-white/5 p-6 text-center text-white/40">
          Nothing playing. Add a song from the Search tab.
        </div>
      )}

      <div className="mt-6 mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-white/40">
          Up next · {items.length}
        </h3>
        {items.length > 1 && (
          <span className="text-xs text-white/30">drag ⠿ to reorder</span>
        )}
      </div>
      <Reorder.Group
        axis="y"
        values={items}
        onReorder={setItems}
        className="space-y-2"
      >
        {items.map((item, i) => (
          <QueueRow
            key={item.id}
            item={item}
            index={i}
            onRemove={onRemove}
            onCommit={commitOrder}
          />
        ))}
      </Reorder.Group>
      {items.length === 0 && (
        <p className="text-sm text-white/30">Queue is empty.</p>
      )}
    </div>
  );
}

// A single queued song. Dragging is disabled on the row body (so touching the
// title/thumbnail just scrolls); only the ⠿ grip starts a reorder, via
// dragControls. Commits the new order to the server when the drag ends.
function QueueRow({
  item,
  index,
  onRemove,
  onCommit,
}: {
  item: QueueItem;
  index: number;
  onRemove: (id: string) => void;
  onCommit: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onCommit}
      whileDrag={{ scale: 1.03 }}
      className="flex items-center gap-2 rounded-xl bg-white/5 p-2"
    >
      <span
        onPointerDown={(e) => controls.start(e)}
        className="cursor-grab touch-none select-none px-1 text-lg text-white/30 active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        ⠿
      </span>
      <span className="w-4 text-center text-sm text-white/30">{index + 1}</span>
      <img
        src={item.thumbnail}
        alt=""
        className="h-10 w-16 rounded object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="truncate text-xs text-fuchsia-300">{item.singer}</div>
      </div>
      <button
        type="button"
        onClick={() => onRemove(item.id)}
        className="shrink-0 px-2 text-white/30 active:text-white"
        aria-label="Remove"
      >
        ✕
      </button>
    </Reorder.Item>
  );
}
