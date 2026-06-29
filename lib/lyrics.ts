// Lyrics fetching for the now-playing song. Primary source is LRCLIB
// (lrclib.net) — free, no API key, returns time-synced LRC lyrics. When LRCLIB
// has nothing we fall back to Musixmatch via RapidAPI (300 free calls/month),
// so results are cached in SQLite (incl. misses) to spend that quota sparingly.
//
// YouTube titles are messy ("Artist - Song (Official Video) [4K]"), so we clean
// them into an artist/track guess before querying.

import type { LyricLine, LyricsResult } from "@/lib/types";
import { getCachedLyrics, putCachedLyrics, rejectLyrics } from "@/lib/db";
import { formatTime } from "@/lib/format";

// How long to trust a cached MISS before trying the network again. Hits are
// cached forever; misses expire so a song that gains lyrics later can be found.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Be a good LRCLIB citizen — they ask for an identifying User-Agent.
const USER_AGENT =
  "SingAlong (https://github.com/; karaoke web app)";

// Cap each upstream request so a slow provider can't hang the whole lookup.
const FETCH_TIMEOUT_MS = 8000;

// ---- Title cleanup ----

// Junk that appears in YouTube music titles but isn't part of artist/track.
const NOISE = [
  "official video",
  "official music video",
  "official audio",
  "official lyric video",
  "official lyrics video",
  "lyric video",
  "lyrics video",
  "lyrics",
  "lyric",
  "music video",
  "visualizer",
  "audio",
  "video",
  "hd",
  "hq",
  "4k",
  "8k",
  "mv",
  "m/v",
  "color coded",
  "karaoke",
  "instrumental",
  "remastered",
  "full version",
];

// Drop "feat. X" credits and standalone noise words ("Official Video", etc.).
function stripNoise(s: string): string {
  s = s.replace(/\b(feat|ft|featuring)\.?\s+[^-–|]+/gi, " ");
  for (const word of NOISE) {
    s = s.replace(new RegExp(`\\b${word.replace("/", "\\/")}\\b`, "gi"), " ");
  }
  return s.replace(/\s+/g, " ").trim();
}

// Tidy a field: drop quotes and any separator punctuation left dangling at the
// ends after noise removal (e.g. "Bohemian Rhapsody -" → "Bohemian Rhapsody").
function tidy(v: string): string {
  return v
    .replace(/["“”]/g, "")
    .replace(/^[\s\-–|]+|[\s\-–|]+$/g, "")
    .trim();
}

// CJK song titles often bundle a Latin translation alongside the real name, e.g.
// "光年之外 LIGHT YEARS AWAY". The Latin alias causes FALSE matches against
// unrelated Latin songs of that name (both score a "contains" 2), so when a
// title mixes CJK with Latin, keep just the CJK part — its true title.
const CJK_RE = /[㐀-鿿぀-ヿ가-힯]/;
function preferCjkName(track: string): string {
  if (!CJK_RE.test(track)) return track;
  const cjkOnly = track.replace(/[A-Za-z]+/g, " ").replace(/\s+/g, " ").trim();
  return cjkOnly || track;
}

// Parse a raw YouTube title into a best-guess { artist?, track }.
export function parseTitle(raw: string): { artist?: string; track: string } {
  // CJK videos usually put the SONG NAME inside 【…】 / 「…」 / 『…』 with the
  // artist before it, e.g. "G.E.M.鄧紫棋【差不多姑娘】Official MV". Pull the track
  // from inside the bracket and the artist from before it — don't strip it as an
  // aside like we do with "(Official Video)".
  const cjk = raw.match(/^(.+?)[【「『]([^】」』]+)[】」』]/);
  if (cjk) {
    const artist = tidy(stripNoise(cjk[1]));
    const track = preferCjkName(tidy(stripNoise(cjk[2])));
    if (artist && track) return { artist, track };
    if (track) return { track };
  }

  // Otherwise: drop parenthesised/bracketed asides — (Official Video), [4K],
  // and any stray CJK brackets — then strip noise words.
  let s = raw.replace(/[([{【「『][^)\]}】」』]*[)\]}】」』]/g, " ");
  s = stripNoise(s);

  // Split "Artist - Track" (also – em dash, | pipe). The FIRST separator wins,
  // so "Artist - Track - Live" keeps "Track - Live" as the track.
  const sep = s.match(/^(.+?)\s*[-–|]\s*(.+)$/);
  if (sep) {
    const artist = tidy(sep[1]);
    const track = preferCjkName(tidy(sep[2]));
    if (artist && track) return { artist, track };
  }

  return { track: preferCjkName(tidy(s)) || raw.trim() };
}

// ---- LRC parsing ----

const LRC_TIME = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

// Parse an LRC string into time-sorted lyric lines. A single text line may carry
// several timestamps ([..][..] text) — each becomes its own line. Metadata-only
// tags ([ar:], [ti:], [length:]…) and blank lines are dropped.
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    LRC_TIME.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = LRC_TIME.exec(rawLine)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      // Fractional part may be 2 (centis) or 3 (millis) digits; normalise.
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      stamps.push(min * 60 + sec + frac);
    }
    if (stamps.length === 0) continue;
    const text = rawLine.replace(LRC_TIME, "").trim();
    for (const t of stamps) out.push({ timeSec: t, text });
  }
  out.sort((a, b) => a.timeSec - b.timeSec);
  return out;
}

// Split a plain (un-timed) lyrics blob into display lines.
function plainToLines(plain: string): LyricLine[] {
  return plain
    .split(/\r?\n/)
    .map((t) => ({ timeSec: 0, text: t.trim() }))
    .filter((l, i, arr) => l.text || (i > 0 && arr[i - 1].text)); // collapse runs of blanks
}

// A stable short signature of a lyrics result (its normalised line text). Used
// to remember which match a user reported as wrong so a re-fetch can skip it.
export function lyricsSignature(result: LyricsResult): string {
  const text = result.lines
    .map((l) => l.text.trim().toLowerCase())
    .filter(Boolean)
    .join("\n");
  let h = 5381; // djb2
  for (let i = 0; i < text.length; i++) h = (((h << 5) + h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Normalise a song/artist name for comparison: lowercase, strip diacritics and
// punctuation, collapse whitespace. Keeps letters/numbers of ANY script so CJK
// titles compare correctly. So "Beyoncé - HALO!" ≈ "beyonce halo" and
// "【差不多姑娘】" ≈ "差不多姑娘".
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // strip combining marks (diacritics)
    .replace(/[^\p{L}\p{N}]+/gu, " ") // keep letters/numbers of any language
    .trim();
}

// How well a candidate's name matches what we asked for: 3 = exact, 2 = one
// contains the other, 0 = no match. Empty inputs score 0.
export function nameScore(want: string, got: string): number {
  const a = normalizeName(want);
  const b = normalizeName(got);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  return 0;
}

// ---- LRCLIB ----

type LrclibTrack = {
  trackName?: string;
  artistName?: string;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  duration?: number;
};

function fromLrclib(track: LrclibTrack): LyricsResult | null {
  if (track.instrumental) return null;
  if (track.syncedLyrics) {
    const lines = parseLrc(track.syncedLyrics);
    if (lines.length) return { synced: true, lines, source: "lrclib" };
  }
  if (track.plainLyrics) {
    const lines = plainToLines(track.plainLyrics);
    if (lines.length) return { synced: false, lines, source: "lrclib" };
  }
  return null;
}

async function fetchLrclib(
  artist: string | undefined,
  track: string,
  durationSec: number,
  rejected: Set<string>
): Promise<LyricsResult | null> {
  const headers = { "User-Agent": USER_AGENT };

  // Exact lookup first — needs artist + duration to disambiguate. A failure
  // here (miss or timeout) must still fall through to the search below.
  if (artist && durationSec > 0) {
    const url =
      `https://lrclib.net/api/get?` +
      `artist_name=${encodeURIComponent(artist)}` +
      `&track_name=${encodeURIComponent(track)}` +
      `&duration=${Math.round(durationSec)}`;
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const got = fromLrclib((await res.json()) as LrclibTrack);
        if (got && !rejected.has(lyricsSignature(got))) return got;
      }
    } catch {
      // ignore — fall through to the fuzzy search
    }
  }

  // Search fallback. LRCLIB matches its STRUCTURED params (track_name +
  // artist_name) far better than a free-text query — especially for non-Latin
  // titles — so try that first, then fall back to a free-text query. Each query
  // returns many songs (often by the same artist), so we always verify the
  // candidate's track name actually matches before accepting it.
  const queries: URLSearchParams[] = [];
  if (artist) {
    queries.push(
      new URLSearchParams({ track_name: track, artist_name: artist })
    );
  }
  queries.push(new URLSearchParams({ q: artist ? `${artist} ${track}` : track }));
  queries.push(new URLSearchParams({ q: track }));

  for (const params of queries) {
    let candidates: LrclibTrack[];
    try {
      const res = await fetch(`https://lrclib.net/api/search?${params}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      candidates = (await res.json()) as LrclibTrack[];
    } catch {
      continue; // timeout/network — try the next query
    }
    const got = pickBestCandidate(candidates, track, artist, durationSec, rejected);
    if (got) return got;
  }
  return null;
}

// Choose the best LRCLIB search result. We require the candidate's track name to
// actually match (no match = a different song), then rank by title-match →
// artist-match → synced-over-plain → closest duration. Duration is only a
// tiebreaker, never a reject: a music video is usually longer than the studio
// track these lyrics are timed to.
function pickBestCandidate(
  candidates: LrclibTrack[],
  track: string,
  artist: string | undefined,
  durationSec: number,
  rejected: Set<string>
): LyricsResult | null {
  if (!Array.isArray(candidates)) return null;
  const ranked = candidates
    .filter((c) => c.syncedLyrics || c.plainLyrics)
    .map((c) => ({
      c,
      track: nameScore(track, c.trackName ?? ""),
      artist: artist ? nameScore(artist, c.artistName ?? "") : 0,
      hasSynced: !!c.syncedLyrics,
      diff:
        durationSec > 0 && c.duration
          ? Math.abs(c.duration - durationSec)
          : Number.POSITIVE_INFINITY,
    }))
    .filter((x) => x.track > 0)
    .sort(
      (a, b) =>
        b.track - a.track ||
        b.artist - a.artist ||
        Number(b.hasSynced) - Number(a.hasSynced) ||
        a.diff - b.diff
    );

  // Best match whose lyrics weren't reported wrong (so a report surfaces the
  // next-best different match).
  for (const x of ranked) {
    const got = fromLrclib(x.c);
    if (got && !rejected.has(lyricsSignature(got))) return got;
  }
  return null;
}

// ---- Musixmatch (RapidAPI) fallback ----
//
// Only called when LRCLIB returns nothing. Targets the "musixmatch-lyrics-songs"
// RapidAPI provider, which returns SYNCED lyrics (an LRC string in `lrc_lyrics`)
// plus a `plain_lyrics` fallback. Configured via env:
//   RAPIDAPI_KEY              — your RapidAPI key (required to enable this)
//   MUSIXMATCH_RAPIDAPI_HOST  — optional host override (defaults below)
const DEFAULT_MUSIXMATCH_HOST = "musixmatch-lyrics-songs.p.rapidapi.com";

type MxmResponse = {
  success?: boolean;
  lrc_lyrics?: string | null;
  plain_lyrics?: string | null;
  track_info?: { track_name?: string; artist_name?: string };
};

export function parseMusixmatch(data: unknown): LyricsResult | null {
  const d = data as MxmResponse;
  if (!d || d.success === false) return null;
  if (d.lrc_lyrics) {
    const lines = parseLrc(d.lrc_lyrics);
    if (lines.length) return { synced: true, lines, source: "musixmatch" };
  }
  if (d.plain_lyrics) {
    const lines = plainToLines(d.plain_lyrics);
    if (lines.length) return { synced: false, lines, source: "musixmatch" };
  }
  return null;
}

async function fetchMusixmatch(
  artist: string | undefined,
  track: string,
  durationSec: number,
  rejected: Set<string>
): Promise<LyricsResult | null> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return null; // not configured → skip (LRCLIB-only)
  const host = process.env.MUSIXMATCH_RAPIDAPI_HOST || DEFAULT_MUSIXMATCH_HOST;

  // URLSearchParams matches this API's expected encoding exactly: spaces → "+",
  // and the duration's ":" → "%3A" (e.g. d=3%3A11).
  const params = new URLSearchParams({ t: track });
  if (artist) params.set("a", artist);
  if (durationSec > 0) params.set("d", formatTime(durationSec));

  try {
    const res = await fetch(`https://${host}/songs/lyrics?${params}`, {
      headers: { "x-rapidapi-key": key, "x-rapidapi-host": host },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MxmResponse;
    // Guard against a wrong-song match: the returned track name must match.
    const returned = data.track_info?.track_name;
    if (returned && nameScore(track, returned) === 0) return null;
    const result = parseMusixmatch(data);
    // Skip a match the user already reported wrong for this video.
    if (result && rejected.has(lyricsSignature(result))) return null;
    return result;
  } catch {
    return null; // never let the fallback break the request
  }
}

// ---- Orchestrator (with SQLite cache) ----

export async function getLyrics(
  videoId: string,
  rawTitle: string,
  durationSec: number,
  opts: { force?: boolean } = {}
): Promise<LyricsResult | null> {
  const cached = getCachedLyrics(videoId);

  // `force` skips the cache read (re-queries the providers) — used by the
  // ?refresh=1 debug flag. We still write the fresh result back below.
  if (!opts.force && cached) {
    if (cached.result) return cached.result; // cached hit
    if (Date.now() - cached.fetchedAt < MISS_TTL_MS) return null; // cached miss
  }

  // Matches the user reported as wrong — skip them so we find a different one.
  const rejected = new Set(cached?.rejected ?? []);

  const { artist, track } = parseTitle(rawTitle);

  let result: LyricsResult | null = null;
  try {
    result = await fetchLrclib(artist, track, durationSec, rejected);
  } catch {
    result = null;
  }
  if (!result) {
    result = await fetchMusixmatch(artist, track, durationSec, rejected);
  }

  putCachedLyrics(videoId, result);
  return result;
}

// Report the currently-cached lyrics for a video as wrong: record this match's
// signature (so it's skipped) and clear the cache, so the next lookup re-queries
// the providers and picks a DIFFERENT match.
export function reportWrongLyrics(videoId: string): void {
  const cached = getCachedLyrics(videoId);
  const signature = cached?.result ? lyricsSignature(cached.result) : "";
  rejectLyrics(videoId, signature);
}
