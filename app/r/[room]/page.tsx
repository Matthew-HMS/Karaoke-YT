"use client";

// The phone remote. Guests search YouTube (or paste a link), add songs with
// their name, see the queue, and control playback (play/pause/skip + an
// instant seek bar — the headline "jump to any part, no download" feature).

import { AnimatePresence, motion } from "framer-motion";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";
import { useRoom } from "@/lib/useRoom";
import type { QueueItem } from "@/lib/types";

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

export default function RemotePage() {
  const code = String(useParams().room || "").toUpperCase();
  const {
    state,
    livePlayer,
    connected,
    addSong,
    removeSong,
    sendCommand,
  } = useRoom(code, "remote");

  const [tab, setTab] = useState<Tab>("search");
  const [name, setName] = useState("");

  // Remember the singer's name across reloads.
  useEffect(() => {
    setName(localStorage.getItem("singer-name") || "");
  }, []);
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
      setTab("queue");
    },
    [addSong, name]
  );

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
        <input
          value={name}
          onChange={(e) => saveName(e.target.value)}
          placeholder="Your name (shown on the big screen)"
          className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-fuchsia-400"
        />
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
        {tab === "search" && <SearchTab onAdd={add} />}
        {tab === "favorites" && <LibraryTab endpoint="/api/favorites" onAdd={add} favorites />}
        {tab === "recent" && <LibraryTab endpoint="/api/history" onAdd={add} />}
        {tab === "queue" && (
          <QueueTab
            queue={state?.queue ?? []}
            nowPlaying={state?.nowPlaying ?? null}
            player={livePlayer ?? state?.playerState ?? null}
            onRemove={removeSong}
            onCommand={sendCommand}
          />
        )}
      </div>
    </main>
  );
}

function SearchTab({ onAdd }: { onAdd: (r: SearchResult) => void }) {
  const [q, setQ] = useState("");
  const [karaokeOnly, setKaraokeOnly] = useState(true);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const star = async (r: SearchResult) => {
    setStarred((prev) => new Set(prev).add(r.videoId));
    await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    });
  };

  const looksLikeUrl = /youtu\.be\/|youtube\.com\//.test(q);

  const runSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&karaokeOnly=${
            karaokeOnly ? "1" : "0"
          }`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Search failed");
        setResults(data.results);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [karaokeOnly]
  );

  // Debounced search-as-you-type (skips when the input is a pasted URL).
  useEffect(() => {
    if (looksLikeUrl) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => runSearch(q), 450);
    return () => clearTimeout(debounce.current);
  }, [q, looksLikeUrl, runSearch]);

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

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search songs, or paste a YouTube link"
        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 outline-none focus:border-fuchsia-400"
      />

      {looksLikeUrl ? (
        <button
          onClick={addPastedLink}
          disabled={loading}
          className="mt-3 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 py-3 font-bold disabled:opacity-50"
        >
          {loading ? "Adding…" : "➕ Add this link"}
        </button>
      ) : (
        <label className="mt-3 flex items-center gap-2 text-sm text-white/60">
          <input
            type="checkbox"
            checked={karaokeOnly}
            onChange={(e) => setKaraokeOnly(e.target.checked)}
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
        {results.map((r) => (
          <li
            key={r.videoId}
            className="flex items-center gap-3 rounded-xl bg-white/5 p-2"
          >
            <img
              src={r.thumbnail}
              alt=""
              className="h-12 w-20 rounded object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-sm font-medium">{r.title}</div>
              {r.durationSec > 0 && (
                <div className="text-xs text-white/40">
                  {formatTime(r.durationSec)}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => star(r)}
              className={`shrink-0 px-2 text-lg active:scale-90 ${
                starred.has(r.videoId) ? "text-amber-300" : "text-white/30"
              }`}
              aria-label="Save to favorites"
            >
              {starred.has(r.videoId) ? "★" : "☆"}
            </button>
            <button
              type="button"
              onClick={() => onAdd(r)}
              className="shrink-0 rounded-lg bg-fuchsia-500 px-3 py-2 text-sm font-bold active:scale-95"
            >
              Add
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Favorites + Recently-played share this: fetch a song list and offer one-tap
// re-adding. Favorites additionally show an unstar (✕) button.
function LibraryTab({
  endpoint,
  onAdd,
  favorites = false,
}: {
  endpoint: string;
  onAdd: (r: SearchResult) => void;
  favorites?: boolean;
}) {
  const [items, setItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint);
      const data = await res.json();
      setItems(data.results ?? []);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    load();
  }, [load]);

  const unstar = async (videoId: string) => {
    await fetch(`/api/favorites?videoId=${encodeURIComponent(videoId)}`, {
      method: "DELETE",
    });
    setItems((prev) => prev.filter((i) => i.videoId !== videoId));
  };

  if (loading) return <p className="text-sm text-white/40">Loading…</p>;
  if (items.length === 0)
    return (
      <p className="text-sm text-white/30">
        {favorites
          ? "No favorites yet. Tap ☆ on a search result to save it."
          : "Nothing’s been played yet."}
      </p>
    );

  return (
    <ul className="space-y-2">
      {items.map((r) => (
        <li
          key={r.videoId}
          className="flex items-center gap-3 rounded-xl bg-white/5 p-2"
        >
          <img src={r.thumbnail} alt="" className="h-12 w-20 rounded object-cover" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-sm font-medium">{r.title}</div>
            {r.durationSec > 0 && (
              <div className="text-xs text-white/40">
                {formatTime(r.durationSec)}
              </div>
            )}
          </div>
          {favorites && (
            <button
              type="button"
              onClick={() => unstar(r.videoId)}
              className="shrink-0 px-2 text-white/30 active:text-white"
              aria-label="Remove favorite"
            >
              ✕
            </button>
          )}
          <button
            type="button"
            onClick={() => onAdd(r)}
            className="shrink-0 rounded-lg bg-fuchsia-500 px-3 py-2 text-sm font-bold active:scale-95"
          >
            Add
          </button>
        </li>
      ))}
    </ul>
  );
}

function QueueTab({
  queue,
  nowPlaying,
  player,
  onRemove,
  onCommand,
}: {
  queue: QueueItem[];
  nowPlaying: QueueItem | null;
  player: { status: string; currentTimeSec: number; durationSec: number } | null;
  onRemove: (id: string) => void;
  onCommand: ReturnType<typeof useRoom>["sendCommand"];
}) {
  const isPlaying = player?.status === "playing";
  const dur = player?.durationSec ?? 0;
  const cur = player?.currentTimeSec ?? 0;

  return (
    <div>
      {nowPlaying ? (
        <div className="rounded-2xl bg-gradient-to-br from-fuchsia-500/20 to-pink-500/10 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">
            Now playing
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
              onClick={() => onCommand({ cmd: "restart" })}
              className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold active:scale-95"
            >
              ⏮ Restart
            </button>
            <button
              onClick={() => onCommand({ cmd: isPlaying ? "pause" : "play" })}
              className="rounded-full bg-white px-6 py-2 text-sm font-bold text-black active:scale-95"
            >
              {isPlaying ? "⏸ Pause" : "▶ Play"}
            </button>
            <button
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

      <h3 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-white/40">
        Up next · {queue.length}
      </h3>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {queue.map((item, i) => (
            <motion.li
              key={item.id}
              layout
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
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
                <div className="truncate text-sm font-medium">{item.title}</div>
                <div className="truncate text-xs text-fuchsia-300">
                  {item.singer}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                className="shrink-0 px-2 text-white/30 active:text-white"
                aria-label="Remove"
              >
                ✕
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
        {queue.length === 0 && (
          <li className="text-sm text-white/30">Queue is empty.</li>
        )}
      </ul>
    </div>
  );
}
