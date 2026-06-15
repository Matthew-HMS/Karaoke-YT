"use client";

// Shared song-browsing UI used by BOTH the phone remote and the host screen:
// the Search / Favorites / Recent tab bodies plus the reusable song row and the
// sign-in prompt. Keeping these in one place means the host and the remote stay
// in sync. (The Queue tab differs per surface, so it lives in each page.)

import { Reorder, useDragControls } from "framer-motion";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { isValidPassword, normalizePassword } from "@/lib/code";
import { formatTime } from "@/lib/format";
import type { PlayerCommand, QueueItem, SfxName } from "@/lib/types";

export type { SearchResult } from "@/lib/youtube";
import type { SearchResult } from "@/lib/youtube";

export type Tab = "search" | "favorites" | "recent" | "queue";

export const TAB_LABELS: Record<Tab, string> = {
  search: "Search",
  favorites: "★ Faves",
  recent: "Recent",
  queue: "Queue",
};

// Reaction buttons → play a sound effect on the TV (host).
export const SFX_BUTTONS: { name: SfxName; emoji: string; label: string }[] = [
  { name: "applause", emoji: "👏", label: "Applause" },
  { name: "whistle", emoji: "😗", label: "Whistle" },
  { name: "airhorn", emoji: "📯", label: "Airhorn" },
  { name: "tada", emoji: "🎉", label: "Ta-da" },
  { name: "drumroll", emoji: "🥁", label: "Drumroll" },
  { name: "sadtrombone", emoji: "📉", label: "Sad trombone" },
];

export function SignInPrompt({ message }: { message: string }) {
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
export function SongRow({
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
  trailing?: ReactNode;
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

export function SearchTab({
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
export function FavoritesTab({
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
export function RecentTab({
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

export function QueueTab({
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
  onCommand: (cmd: PlayerCommand) => void;
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

// Shown when a code has no active room (a guest's wrong code, or a typed host
// URL for a room that was never created).
export function RoomMissing({ code }: { code: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="text-5xl">🤷</div>
      <h1 className="mt-4 text-2xl font-bold">Room not found</h1>
      <p className="mt-2 text-white/50">
        No active room with code <span className="font-mono font-bold">{code}</span>.
        Check the code, or ask the host to start the room.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-xl bg-white/10 px-5 py-2.5 font-semibold active:scale-95"
      >
        ← Back
      </Link>
    </main>
  );
}

// Password prompt before a guest joins (or a co-host opens) an existing room.
export function PasswordGate({
  code,
  showError,
  onSubmit,
}: {
  code: string;
  showError: boolean;
  onSubmit: (pw: string) => void;
}) {
  const [pw, setPw] = useState("");
  const [hint, setHint] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Submit using the input's *live DOM value*, not just React state. On phones,
  // autofill / IME / autocapitalize can commit the last character late, leaving
  // the controlled `pw` state a step behind — which previously kept the Join
  // button disabled (dark) even though the field looked complete. Reading the
  // DOM value here sidesteps that desync entirely.
  const trySubmit = () => {
    const val = normalizePassword(inputRef.current?.value ?? pw);
    if (isValidPassword(val)) {
      setHint(false);
      onSubmit(val);
    } else {
      setHint(true);
      inputRef.current?.focus();
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="w-full max-w-xs text-center">
        <div className="text-5xl">🔒</div>
        <h1 className="mt-4 text-2xl font-bold">Join room {code}</h1>
        <p className="mt-2 text-sm text-white/50">
          Enter the 4-letter password shown on the TV.
        </p>
        <input
          ref={inputRef}
          value={pw}
          onChange={(e) => {
            setPw(normalizePassword(e.target.value));
            setHint(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && trySubmit()}
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={4}
          placeholder="····"
          className="mt-5 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-3xl font-black tracking-[0.4em] uppercase outline-none focus:border-fuchsia-400"
        />
        {showError && (
          <p className="mt-2 text-sm text-amber-400">Incorrect password.</p>
        )}
        {hint && !showError && (
          <p className="mt-2 text-sm text-white/50">
            Enter all 4 characters of the password.
          </p>
        )}
        {/* Always enabled/clickable — validation happens on tap so the button is
            never stuck in a dark, un-tappable disabled state. */}
        <button
          type="button"
          onClick={trySubmit}
          className="mt-4 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 py-3 font-bold active:scale-[0.99]"
        >
          Join
        </button>
      </div>
    </main>
  );
}
