"use client";

// The lyrics view that sits behind the play controls on the now-playing card
// (swipe left to reveal it). Fetches lyrics for the current song from
// /api/lyrics, then either highlights the active line in time with playback
// (synced LRC) or shows the words as plain scrollable text. Driven by the same
// playback position the rest of the queue UI already has, so no extra wiring.

import { useEffect, useMemo, useRef, useState } from "react";
import { formatWait } from "@/lib/format";
import type { FuriganaSegment, LyricLine } from "@/lib/types";
import { useSettings } from "@/lib/useSettings";

// Kana (hiragana/katakana) ⇒ Japanese. Inlined here (not imported from
// lib/romanize, which pulls in the SQLite db) so this stays a client module.
const KANA_RE = /[ぁ-ゖ゠-ヿｦ-ﾝ]/;

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
  const settings = useSettings();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  // Japanese reading aids, aligned 1:1 with the lyric lines (null = none / not
  // Japanese / not requested). Only one is populated, per the settings mode.
  const [romaji, setRomaji] = useState<string[] | null>(null);
  const [furigana, setFurigana] = useState<FuriganaSegment[][] | null>(null);
  const [translation, setTranslation] = useState<string[] | null>(null);
  // A small hint shown when the reading aid can't load (rate limit / quota).
  const [readingNote, setReadingNote] = useState<string | null>(null);
  // Bumped by the "Retry" button to re-run the reading fetch for the SAME song /
  // mode / model — e.g. after a timeout, or after switching to a faster model.
  // (Re-selecting the same reading mode doesn't change a dep, so without this
  // there'd be no way to retry a failed reading.)
  const [readingRetry, setReadingRetry] = useState(0);
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
  const activeRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track what the last reading fetch used, to decide when to FORCE a re-translate
  // (bypass the per-video cache): when the model changed (a better model should
  // re-translate the song) or the user hit Retry. A plain song change keeps using
  // the cache — re-running the same model is deterministic, so it'd be identical.
  const lastReadingModel = useRef(settings.orcaModel);
  const lastReadingRetry = useRef(readingRetry);
  // Same refresh tracking for the (independent) translation fetch.
  const lastTransModel = useRef(settings.orcaModel);
  const lastTransRetry = useRef(readingRetry);

  // (Re)fetch whenever the song changes — or after a report (reloadKey).
  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    setOffset(0);
    setConfirmReport(false);
    setRomaji(null);
    setFurigana(null);
    setTranslation(null);
    const params = new URLSearchParams({
      videoId,
      title,
      duration: String(Math.round(durationSec)),
    });
    // Smart lyrics cleanup: let the server try an LLM title parse on a miss.
    const useAi = settings.smartCleanup && settings.aiAvailable;
    if (useAi) params.set("ai", "1");
    const controller = new AbortController();
    fetch(`/api/lyrics?${params}`, {
      signal: controller.signal,
      headers: useAi ? settings.authHeaders() : undefined,
    })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `durationSec` is rounded in the dep for the same reason it's rounded in the
    // query: the player re-reports a float every second, and re-running this on
    // sub-second jitter would hand the AI effects a fresh `data` object each time.
  }, [videoId, title, Math.round(durationSec), reloadKey, settings.smartCleanup, settings.aiAvailable, settings.orcaKey]);

  // The lyric texts, plus a VALUE key for them. The AI effects below must depend
  // on this key and not on `data`: the player reports its duration every second
  // (YouTubePlayer onReport), so `durationSec` changes at least once per song
  // (0 → real), the lyrics effect re-runs, and `setData` hands back a brand-new
  // object with identical content. Depending on the object re-fired both AI
  // effects on every one of those — duplicate, concurrent, *billed* model calls
  // whose results were then thrown away by the `active = false` cleanup.
  const texts = useMemo(
    () => (data?.found ? (data.lines ?? []).map((l) => l.text) : []),
    [data]
  );
  const textsKey = texts.join("\n");

  // Japanese reading aid: when a mode is picked and the lyrics are Japanese,
  // fetch romaji (Latin, under each line) or furigana (hiragana, over kanji).
  // Runs after lyrics load; both are cached server-side per video.
  useEffect(() => {
    setRomaji(null);
    setFurigana(null);
    setReadingNote(null);
    const mode = settings.jpReading;
    if (mode === "off" || !settings.aiAvailable || !texts.length) return;
    if (!texts.some((t) => KANA_RE.test(t))) return; // not Japanese → skip
    let active = true;
    // Force a fresh translation (bypassing the cache) when the model changed or
    // the user hit Retry; a plain song change just uses the cache.
    const refresh =
      lastReadingModel.current !== settings.orcaModel ||
      lastReadingRetry.current !== readingRetry;
    lastReadingModel.current = settings.orcaModel;
    lastReadingRetry.current = readingRetry;
    const url = mode === "furigana" ? "/api/furigana" : "/api/romanize";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...settings.authHeaders() },
      body: JSON.stringify({ videoId, lines: texts, refresh }),
    })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ status, body }) => {
        if (!active) return;
        const d = body as {
          furigana?: unknown;
          romaji?: unknown;
          code?: unknown;
          limit?: unknown;
          retryAfter?: unknown;
        };
        if (mode === "furigana" && Array.isArray(d.furigana)) {
          setFurigana(d.furigana as FuriganaSegment[][]);
        } else if (mode === "romaji" && Array.isArray(d.romaji)) {
          setRomaji(d.romaji as string[]);
        } else if (d.code === "bad_key") {
          setReadingNote("That OrcaRouter key was rejected — check it in ⚙ Settings (or clear it to use the free AI).");
        } else if (d.code === "no_credits") {
          setReadingNote("Your key has no credits for that model — add credits in ⚙ Settings, or wait for the free pool to reopen.");
        } else if (d.code === "backup_failed") {
          setReadingNote("Free AI is at capacity and the paid backup key failed too — the host needs to check it.");
        } else if (d.code === "free_exhausted") {
          setReadingNote("Free AI is used up for today — add credits or your own key in ⚙ Settings.");
        } else if (status === 402) {
          const n = typeof d.limit === "number" ? d.limit : settings.freeLimit;
          setReadingNote(`Free AI limit (${n}) reached — add your own key in ⚙ Settings.`);
        } else if (d.code === "slow_model") {
          setReadingNote("That model was too slow (timed out). Pick a faster one in ⚙ Settings — e.g. qwen/qwen3.7-flash or deepseek/deepseek-v4-flash.");
        } else if (status === 429) {
          // The free model's cooldown is global and often hours long — name it.
          const wait = typeof d.retryAfter === "number" ? formatWait(d.retryAfter) : null;
          setReadingNote(
            wait
              ? `Free AI is at capacity — it reopens in about ${wait}. Add your own key (with credits) in ⚙ Settings to skip the wait.`
              : "AI is busy — reading unavailable right now. Try again shortly."
          );
        } else if (status >= 400) {
          // Any other failure (e.g. a 502) — don't fail silently.
          setReadingNote("Couldn't load the reading right now.");
        }
        settings.refreshStatus(); // a reading may have spent a free use
      })
      .catch(() => {
        if (active) setReadingNote("Couldn't load the reading right now.");
      });
    return () => {
      active = false;
    };
    // Re-fetch when the key/model change too, so pasting your own key (or
    // changing the model) immediately retries the reading for the current song;
    // readingRetry lets the user force a retry with no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, textsKey, settings.jpReading, settings.aiAvailable, settings.orcaKey, settings.orcaModel, readingRetry]);

  // Lyrics translation to the chosen target language — an independent aid shown
  // under each line (meaning, not pronunciation). Same shape as the reading
  // fetch: cached server-side, bypassed on model change / Retry, null when the
  // song is already in that language.
  useEffect(() => {
    setTranslation(null);
    const lang = settings.translateTo;
    if (lang === "off" || !settings.aiAvailable || !texts.length) return;
    if (texts.every((t) => !t.trim())) return; // nothing to translate
    let active = true;
    const refresh =
      lastTransModel.current !== settings.orcaModel ||
      lastTransRetry.current !== readingRetry;
    lastTransModel.current = settings.orcaModel;
    lastTransRetry.current = readingRetry;
    fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...settings.authHeaders() },
      body: JSON.stringify({ videoId, lines: texts, lang, refresh }),
    })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ status, body }) => {
        if (!active) return;
        const d = body as { translation?: unknown; code?: unknown; retryAfter?: unknown };
        if (Array.isArray(d.translation)) {
          setTranslation(d.translation as string[]);
        } else if (status >= 400 && d.code === "slow_model") {
          setReadingNote("That model was too slow (timed out). Pick a faster one in ⚙ Settings.");
        } else if (d.code === "backup_failed") {
          setReadingNote("Free AI is at capacity and the paid backup key failed too — the host needs to check it.");
        } else if (status === 429) {
          const wait = typeof d.retryAfter === "number" ? formatWait(d.retryAfter) : null;
          setReadingNote(
            wait
              ? `Free AI is at capacity — it reopens in about ${wait}. Add your own key (with credits) in ⚙ Settings to skip the wait.`
              : "AI is busy — translation unavailable right now. Try again shortly."
          );
        }
        // translation === null (already in that language) → just show nothing.
        settings.refreshStatus();
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, textsKey, settings.translateTo, settings.aiAvailable, settings.orcaKey, settings.orcaModel, readingRetry]);

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
      {/* On error: the hint + Retry. On a shown reading: a subtle Re-translate so
          a wrong/stale one can be re-rolled (e.g. after switching to a better
          model) — both force a fresh, cache-bypassing translation. */}
      {readingNote ? (
        <p className="mb-1 rounded-lg bg-white/5 px-2 py-1 text-center text-[11px] text-amber-300/80">
          {readingNote}{" "}
          <button
            type="button"
            onClick={() => setReadingRetry((k) => k + 1)}
            className="font-semibold text-amber-200 underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      ) : romaji || furigana || translation ? (
        <p className="mb-1 text-center text-[11px] text-white/30">
          <button
            type="button"
            onClick={() => setReadingRetry((k) => k + 1)}
            className="underline underline-offset-2 transition hover:text-white/60"
          >
            ↻ Re-translate
          </button>
        </p>
      ) : null}
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
            const rj = romaji?.[i];
            const furi = furigana?.[i];
            const tr = translation?.[i];
            return (
              <div key={i} ref={isActive ? activeRef : undefined}>
              <p
                className={`pt-1.5 leading-snug transition-colors duration-200 ${
                  rj ? "pb-0" : "pb-1.5"
                } ${
                  furi
                    ? // Keep each reading as ONE unit centred over its own word.
                      // CSS defaults ruby-align to `space-around`, which spreads
                      // the kana evenly across the base — きょう over 今日 renders
                      // as き…ょ…う, each kana appearing to belong to a different
                      // character (and the last one drifting onto the next word).
                      // `inline-block` shrink-wraps the group so the annotation can
                      // never overhang its neighbours, which is the part Chrome
                      // gets wrong without it; ruby-align centres it in engines
                      // that support the property.
                      "[&_ruby]:inline-block [&_ruby]:text-center [&_ruby]:[ruby-align:center] " +
                      "[&_rt]:text-[0.5em] [&_rt]:font-normal [&_rt]:text-fuchsia-200/90 "
                    : ""
                }${
                  isActive
                    ? "text-2xl font-bold text-white"
                    : isPast
                    ? "text-lg text-white/30"
                    : synced
                    ? "text-lg text-white/55"
                    : "text-lg text-white/75"
                }`}
              >
                {furi
                  ? furi.map((s, k) =>
                      s.r ? (
                        <ruby key={k}>
                          {s.t}
                          <rt>{s.r}</rt>
                        </ruby>
                      ) : (
                        <span key={k}>{s.t}</span>
                      )
                    )
                  : line.text || " "}
              </p>
              {/* Romaji under the original line (only when present). */}
              {rj && (
                <p
                  className={`pb-1.5 leading-snug transition-colors duration-200 ${
                    isActive
                      ? "text-base font-medium text-fuchsia-200"
                      : isPast
                      ? "text-xs text-white/20"
                      : "text-xs text-white/40"
                  }`}
                >
                  {rj}
                </p>
              )}
              {/* Translation under the line (meaning), when a target language is set. */}
              {tr && (
                <p
                  className={`pb-1.5 leading-snug italic transition-colors duration-200 ${
                    isActive
                      ? "text-base font-medium text-sky-200"
                      : isPast
                      ? "text-xs text-white/20"
                      : "text-xs text-sky-100/40"
                  }`}
                >
                  {tr}
                </p>
              )}
              </div>
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
