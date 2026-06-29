"use client";

// The lyrics view that sits behind the play controls on the now-playing card
// (swipe left to reveal it). Fetches lyrics for the current song from
// /api/lyrics, then either highlights the active line in time with playback
// (synced LRC) or shows the words as plain scrollable text. Driven by the same
// playback position the rest of the queue UI already has, so no extra wiring.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LyricLine } from "@/lib/types";

// Pretty names for the lyrics provider shown in the header.
const SOURCE_LABELS: Record<string, string> = {
  lrclib: "LRCLIB",
  musixmatch: "Musixmatch",
};

type Props = {
  videoId: string;
  title: string;
  durationSec: number;
  currentTimeSec: number;
  // Only signed-in users may report wrong lyrics (the server enforces it too).
  signedIn: boolean;
  // The host screen gets a "Restore" button to undo a wrong-lyrics report.
  isHost: boolean;
};

type Loaded = {
  found: boolean;
  synced?: boolean;
  lines?: LyricLine[];
  source?: string;
  offset?: number;
  // True when a match was reported wrong for this song (so the host can restore).
  hasRejected?: boolean;
};

export function LyricsPanel({
  videoId,
  title,
  durationSec,
  currentTimeSec,
  signedIn,
  isHost,
}: Props) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  // Manual sync nudge (seconds). Music videos often have an intro/outro the
  // studio-timed lyrics don't account for, so let the user shift the timing.
  // Positive = lyrics wait longer (delay); negative = lyrics run earlier. The
  // value is loaded from / saved to the server so it sticks across plays.
  const [offset, setOffset] = useState(0);
  // Reporting wrong lyrics: the confirm popup. After a report we bump reloadKey
  // to re-fetch — the server has rejected the old match, so a different one loads.
  const [confirmReport, setConfirmReport] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // (Re)fetch whenever the song changes — or after a report (reloadKey).
  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    setOffset(0);
    setConfirmReport(false);
    const params = new URLSearchParams({
      videoId,
      title,
      duration: String(Math.round(durationSec)),
    });
    const controller = new AbortController();
    fetch(`/api/lyrics?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        setData(d);
        if (typeof d.offset === "number") setOffset(d.offset);
      })
      .catch(() => active && setError(true));
    return () => {
      active = false;
      controller.abort();
    };
  }, [videoId, title, durationSec, reloadKey]);

  // Nudge the sync offset and persist it (debounced) so it sticks next time.
  const nudge = (delta: number) => {
    setOffset((o) => {
      const next = Math.round((o + delta) * 10) / 10;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        fetch("/api/lyrics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId, offset: next }),
        }).catch(() => {});
      }, 600);
      return next;
    });
  };

  // Confirm-report → tell the server the lyrics are wrong (it rejects this match
  // and clears the cache), then re-fetch so a different match loads.
  const submitReport = async () => {
    setConfirmReport(false);
    try {
      await fetch(`/api/lyrics?videoId=${encodeURIComponent(videoId)}`, {
        method: "DELETE",
      });
    } catch {
      // ignore — re-fetch anyway
    }
    setReloadKey((k) => k + 1);
  };

  // Host-only: undo a wrong-lyrics report for this song, then re-fetch so the
  // restored match can load again.
  const restoreLyrics = async () => {
    try {
      await fetch("/api/lyrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, restore: true }),
      });
    } catch {
      // ignore — re-fetch anyway
    }
    setReloadKey((k) => k + 1);
  };

  const lines = data?.lines ?? [];
  const synced = !!data?.synced;

  // Index of the current line: the last one whose start time has passed,
  // shifted by the manual offset.
  const activeIndex = useMemo(() => {
    if (!synced || lines.length === 0) return -1;
    const t = currentTimeSec - offset;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].timeSec <= t + 0.15) idx = i;
      else break;
    }
    return idx;
  }, [synced, lines, currentTimeSec, offset]);

  // Keep the active line centred in the scroll area.
  useEffect(() => {
    const el = activeRef.current;
    const box = scrollRef.current;
    if (!el || !box) return;
    box.scrollTo({
      top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2,
      behavior: "smooth",
    });
  }, [activeIndex]);

  const googleLink = (
    <a
      href={`https://www.google.com/search?q=${encodeURIComponent(
        `${title} lyrics`
      )}`}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 inline-block rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold active:scale-95"
    >
      🔍 Search lyrics on Google
    </a>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">
          Lyrics
          {data?.found && data.source && (
            <span className="ml-2 normal-case text-white/30">
              {SOURCE_LABELS[data.source] ?? data.source}
            </span>
          )}
          {data?.found && !synced && (
            <span className="ml-2 normal-case text-white/30">(not synced)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Sync nudge — only useful for time-synced lyrics. */}
          {data?.found && synced && (
            <div className="flex items-center gap-1 text-white/60">
              <button
                type="button"
                onClick={() => nudge(-0.5)}
                aria-label="Lyrics earlier"
                className="rounded bg-white/10 px-2 py-0.5 text-sm leading-none active:scale-90"
              >
                −
              </button>
              <span className="w-12 text-center text-[11px] tabular-nums">
                {offset > 0 ? "+" : ""}
                {offset.toFixed(1)}s
              </span>
              <button
                type="button"
                onClick={() => nudge(0.5)}
                aria-label="Lyrics later"
                className="rounded bg-white/10 px-2 py-0.5 text-sm leading-none active:scale-90"
              >
                +
              </button>
            </div>
          )}
          {/* Report wrong lyrics — only when lyrics are shown and you're signed
              in (the server also restricts this to signed-in users). */}
          {data?.found && signedIn && (
            <button
              type="button"
              onClick={() => setConfirmReport(true)}
              className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-white/50 active:scale-90"
            >
              ⚐ Report
            </button>
          )}
          {/* Restore — host only, and only when this song's lyrics were reported
              wrong; undoes the report so the original match can return. */}
          {isHost && data?.hasRejected && (
            <button
              type="button"
              onClick={restoreLyrics}
              className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-white/50 active:scale-90"
            >
              ↩ Restore
            </button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="no-scrollbar relative min-h-0 flex-1 overflow-y-auto text-center"
      >
        {/* Loading: show the Google link right away as an option while the
            lookup runs; lyrics replace it if found. */}
        {!data && !error && (
          <div className="mt-6">
            <p className="text-sm text-white/40">Looking for lyrics…</p>
            {googleLink}
          </div>
        )}
        {/* Error and not-found both fall back to a Google search. */}
        {(error || (data && !data.found)) && (
          <div className="mt-6">
            <p className="text-sm text-white/40">
              {error
                ? "Couldn’t load lyrics."
                : "No lyrics found for this song."}
            </p>
            {googleLink}
          </div>
        )}
        {data?.found &&
          lines.map((line, i) => {
            const isActive = synced && i === activeIndex;
            const isPast = synced && activeIndex >= 0 && i < activeIndex;
            return (
              <p
                key={i}
                ref={isActive ? activeRef : undefined}
                className={`py-1.5 leading-snug transition-colors duration-200 ${
                  isActive
                    ? "text-2xl font-bold text-white"
                    : isPast
                    ? "text-lg text-white/30"
                    : synced
                    ? "text-lg text-white/55"
                    : "text-lg text-white/75"
                }`}
              >
                {line.text || " "}
              </p>
            );
          })}
      </div>

      {/* Confirm "Report wrong lyrics" */}
      {confirmReport && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setConfirmReport(false)}
        >
          <div
            className="w-full max-w-xs rounded-2xl border border-white/10 bg-[#1a1a22] p-5 text-center shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-3xl">⚐</div>
            <h3 className="mt-2 text-lg font-bold">Report wrong lyrics</h3>
            <p className="mt-1 text-sm text-white/50">
              These lyrics don’t match the song? We’ll skip this version and try
              to find a different match.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmReport(false)}
                className="flex-1 rounded-xl bg-white/10 py-2.5 font-semibold active:scale-95"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitReport}
                className="flex-1 rounded-xl bg-fuchsia-500 py-2.5 font-bold active:scale-95"
              >
                Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
