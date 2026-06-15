"use client";

// Shared "song library" behaviour for the remote and the host: the singer name,
// the per-user favorites (★) set, adding songs to the queue, and a transient
// "added ✓" toast. Centralised so both surfaces behave identically.

import { signIn } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueItem } from "./types";
import type { SearchResult } from "./youtube";

type AddSong = (item: Omit<QueueItem, "id" | "addedBy">) => void;

export function useSongLibrary(opts: {
  addSong: AddSong;
  signedIn: boolean;
  sessionName?: string | null;
}) {
  const { addSong, signedIn, sessionName } = opts;
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
    else if (sessionName) setName(sessionName);
  }, [sessionName]);

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

  return { name, saveName, starred, favorite, add, addMany, toast };
}
