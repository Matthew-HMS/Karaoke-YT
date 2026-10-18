// SQLite persistence for the one thing that should outlive a server restart and
// belongs to a person: each user's starred favorites. (Per-room "recent" is now
// in-memory on the room itself — see lib/rooms.ts — since rooms are ephemeral.)
// One file on disk — perfect for a single VM, no external service.

import Database from "better-sqlite3";
import path from "path";
import type { FuriganaSegment, LyricsResult } from "@/lib/types";

export type SongMeta = {
  videoId: string;
  title: string;
  thumbnail: string;
  durationSec: number;
};

const DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "singalong.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
// Several PROCESSES open this file at once: `next build` collects page data with
// a worker pool, and every worker imports this module and runs the migrations
// below against the same database. WAL allows concurrent readers but only one
// writer, so the losers must wait rather than fail. This is already
// better-sqlite3's default; it's stated explicitly because the migrations
// depend on it and a silent change to that default would be hard to trace.
db.pragma("busy_timeout = 5000");

// Favorites are scoped to a user (Google account id). Primary key is the
// (userId, videoId) pair so two users can each star the same song.
db.exec(`
  CREATE TABLE IF NOT EXISTS favorite (
    userId      TEXT NOT NULL,
    videoId     TEXT NOT NULL,
    title       TEXT NOT NULL,
    thumbnail   TEXT NOT NULL,
    durationSec INTEGER NOT NULL,
    starredAt   INTEGER NOT NULL,
    PRIMARY KEY (userId, videoId)
  );
`);

// Migration for databases created before favorites were user-scoped: if the
// old single-column-PK table exists without userId, recreate it. Favorites are
// disposable party data, so dropping legacy global rows is acceptable.
const cols = db.prepare(`PRAGMA table_info(favorite)`).all() as {
  name: string;
}[];
if (!cols.some((c) => c.name === "userId")) {
  db.exec(`
    DROP TABLE favorite;
    CREATE TABLE favorite (
      userId      TEXT NOT NULL,
      videoId     TEXT NOT NULL,
      title       TEXT NOT NULL,
      thumbnail   TEXT NOT NULL,
      durationSec INTEGER NOT NULL,
      starredAt   INTEGER NOT NULL,
      PRIMARY KEY (userId, videoId)
    );
  `);
}

// Per-user play counts: how many times THIS user's queued songs have played.
db.exec(`
  CREATE TABLE IF NOT EXISTS play (
    userId       TEXT NOT NULL,
    videoId      TEXT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    lastPlayedAt INTEGER NOT NULL,
    PRIMARY KEY (userId, videoId)
  );
`);

const recordPlayStmt = db.prepare(
  `INSERT INTO play (userId, videoId, count, lastPlayedAt)
   VALUES (@userId, @videoId, 1, @at)
   ON CONFLICT(userId, videoId)
   DO UPDATE SET count = count + 1, lastPlayedAt = @at`
);

export function recordPlay(userId: string, videoId: string): void {
  recordPlayStmt.run({ userId, videoId, at: Date.now() });
}

// The user's most-played videoIds, busiest first (ties broken by most recent).
// Used as seed songs for personalized recommendations — only ids are needed
// since the recommender expands each seed into a fresh "related" feed.
const listTopPlayedStmt = db.prepare(
  `SELECT videoId FROM play WHERE userId = ?
   ORDER BY count DESC, lastPlayedAt DESC LIMIT ?`
);

export function listTopPlayed(userId: string, limit: number): string[] {
  const rows = listTopPlayedStmt.all(userId, limit) as { videoId: string }[];
  return rows.map((r) => r.videoId);
}

// Every videoId this user has already favorited or played. The recommender
// subtracts this set so it never suggests a song the user clearly already knows.
const knownVideoIdsStmt = db.prepare(
  `SELECT videoId FROM favorite WHERE userId = @userId
   UNION
   SELECT videoId FROM play WHERE userId = @userId`
);

export function getKnownVideoIds(userId: string): Set<string> {
  const rows = knownVideoIdsStmt.all({ userId }) as { videoId: string }[];
  return new Set(rows.map((r) => r.videoId));
}

export type FavoriteSort = "added" | "plays";

// Favorites, optionally sorted by the user's own play count. A LEFT JOIN keeps
// favorites with zero plays.
const listFavAdded = db.prepare(
  `SELECT videoId, title, thumbnail, durationSec FROM favorite
   WHERE userId = ? ORDER BY starredAt DESC`
);
const listFavPlays = db.prepare(
  `SELECT f.videoId, f.title, f.thumbnail, f.durationSec
   FROM favorite f
   LEFT JOIN play p ON p.userId = f.userId AND p.videoId = f.videoId
   WHERE f.userId = ?
   ORDER BY COALESCE(p.count, 0) DESC, f.starredAt DESC`
);

export function listFavorites(
  userId: string,
  sort: FavoriteSort = "added"
): SongMeta[] {
  const stmt = sort === "plays" ? listFavPlays : listFavAdded;
  return stmt.all(userId) as SongMeta[];
}

const addFavStmt = db.prepare(
  `INSERT INTO favorite (userId, videoId, title, thumbnail, durationSec, starredAt)
   VALUES (@userId, @videoId, @title, @thumbnail, @durationSec, @starredAt)
   ON CONFLICT(userId, videoId) DO NOTHING`
);

export function addFavorite(userId: string, song: SongMeta): void {
  addFavStmt.run({ userId, ...song, starredAt: Date.now() });
}

const removeFavStmt = db.prepare(
  `DELETE FROM favorite WHERE userId = ? AND videoId = ?`
);

export function removeFavorite(userId: string, videoId: string): void {
  removeFavStmt.run(userId, videoId);
}

// Lyrics cache, keyed by YouTube videoId. `data` is the JSON LyricsResult, or
// NULL when we looked and found nothing (a "miss" — cached so we don't keep
// burning the limited Musixmatch quota on songs that have no lyrics). `offset`
// is a manual sync nudge (seconds) the user dialed in for this video, so a
// music video's intro/outro drift stays corrected across future plays.
// `rejected` is a JSON array of signatures for lyric matches a user reported as
// wrong; getLyrics excludes them so a re-fetch finds a DIFFERENT match.
db.exec(`
  CREATE TABLE IF NOT EXISTS lyrics (
    videoId   TEXT PRIMARY KEY,
    data      TEXT,
    fetchedAt INTEGER NOT NULL,
    offset    REAL NOT NULL DEFAULT 0,
    rejected  TEXT
  );
`);

// Migrations for databases created before later columns existed.
const lyricsCols = db.prepare(`PRAGMA table_info(lyrics)`).all() as {
  name: string;
}[];
if (!lyricsCols.some((c) => c.name === "offset")) {
  db.exec(`ALTER TABLE lyrics ADD COLUMN offset REAL NOT NULL DEFAULT 0`);
}
if (!lyricsCols.some((c) => c.name === "rejected")) {
  db.exec(`ALTER TABLE lyrics ADD COLUMN rejected TEXT`);
}

const getLyricsStmt = db.prepare(
  `SELECT data, fetchedAt, offset, rejected FROM lyrics WHERE videoId = ?`
);

// Returns { result, fetchedAt, offset, rejected } when we've looked before
// (result is null for a cached miss), or null when this videoId has never been
// fetched. `rejected` is the list of reported-wrong match signatures.
export function getCachedLyrics(videoId: string): {
  result: LyricsResult | null;
  fetchedAt: number;
  offset: number;
  rejected: string[];
} | null {
  const row = getLyricsStmt.get(videoId) as
    | { data: string | null; fetchedAt: number; offset: number; rejected: string | null }
    | undefined;
  if (!row) return null;
  return {
    result: row.data ? (JSON.parse(row.data) as LyricsResult) : null,
    fetchedAt: row.fetchedAt,
    offset: row.offset,
    rejected: row.rejected ? (JSON.parse(row.rejected) as string[]) : [],
  };
}

// Insert/update the cached lyrics, leaving any existing manual `offset` intact
// (a re-fetch of the same video shouldn't wipe the user's sync nudge).
const putLyricsStmt = db.prepare(
  `INSERT INTO lyrics (videoId, data, fetchedAt)
   VALUES (@videoId, @data, @fetchedAt)
   ON CONFLICT(videoId) DO UPDATE SET data = @data, fetchedAt = @fetchedAt`
);

export function putCachedLyrics(
  videoId: string,
  result: LyricsResult | null
): void {
  putLyricsStmt.run({
    videoId,
    data: result ? JSON.stringify(result) : null,
    fetchedAt: Date.now(),
  });
}

// Save the manual sync offset for a video. Upserts so it works even if the
// lyrics row somehow doesn't exist yet (creates a placeholder miss row).
const setLyricsOffsetStmt = db.prepare(
  `INSERT INTO lyrics (videoId, data, fetchedAt, offset)
   VALUES (@videoId, NULL, @fetchedAt, @offset)
   ON CONFLICT(videoId) DO UPDATE SET offset = @offset`
);

export function setLyricsOffset(videoId: string, offset: number): void {
  setLyricsOffsetStmt.run({ videoId, offset, fetchedAt: Date.now() });
}

// Report the cached lyrics as wrong: remember this match's `signature` so it's
// skipped, clear the stored data, and reset fetchedAt to 0 so the next lookup
// re-queries the providers and finds a DIFFERENT match.
const rejectLyricsStmt = db.prepare(
  `INSERT INTO lyrics (videoId, data, fetchedAt, rejected)
   VALUES (@videoId, NULL, 0, @rejected)
   ON CONFLICT(videoId) DO UPDATE SET data = NULL, fetchedAt = 0, rejected = @rejected`
);

export function rejectLyrics(videoId: string, signature: string): void {
  const current = getCachedLyrics(videoId)?.rejected ?? [];
  if (signature && !current.includes(signature)) current.push(signature);
  rejectLyricsStmt.run({ videoId, rejected: JSON.stringify(current) });
}

// Recovery for a mistaken report: forget all reported-wrong signatures for a
// video and reset fetchedAt so the next lookup re-queries (and can return a
// previously-rejected match again).
const clearRejectedLyricsStmt = db.prepare(
  `UPDATE lyrics SET rejected = NULL, fetchedAt = 0 WHERE videoId = ?`
);

export function clearRejectedLyrics(videoId: string): void {
  clearRejectedLyricsStmt.run(videoId);
}

// Bump when the reading pipeline changes in a way that makes old cached results
// wrong or worse (e.g. the long-song chunking fix) — rows written by an older
// version are then treated as a MISS and regenerated instead of serving a stale,
// truncated "half the song" result. Existing rows (added before the `ver` column)
// default to 0, so they're invalidated the first time a newer version reads them.
//
// 2: replies are now mapped to lyric lines by CONTENT (furigana) or by an index
//    the model echoes back (romaji, translation), instead of by position in the
//    reply. Rows written by version 1 can hold a reading shifted onto the wrong
//    lines — which reads as perfectly fluent text, so nobody would think to hit
//    ↻ Re-translate on it. They have to go.
const READING_CACHE_VERSION = 2;

function hasColumn(table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

// Add a column that an older database predates: the CREATE above omits it so an
// existing table keeps its rows, and this ALTER fills the gap before the
// prepared statements below reference it.
//
// It deliberately does NOT swallow every error. This used to be a bare
// `catch {}` standing in for "column already exists", which also forgave real
// failures: the column would never be added, and the confusing part is that the
// error then surfaced somewhere else entirely — the next db.prepare() dying with
// "no such column". So: check first, and forgive a failed ALTER only when the
// column is genuinely present (another process added it). Anything else throws
// here, where the cause is still visible.
function ensureColumn(table: string, column: string, decl: string): void {
  if (hasColumn(table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (err) {
    if (!hasColumn(table, column)) throw err;
  }
}

const VER_COLUMN = "INTEGER NOT NULL DEFAULT 0";
// `src` holds the hash of the exact lyric lines a cached reading was generated
// for. Without it the cache was keyed on videoId and validated only by LINE
// COUNT, so a video whose lyrics changed to a different match with the same
// number of lines served the OLD readings over the NEW words. Existing rows get
// '' and miss once, then refill.
const SRC_COLUMN = "TEXT NOT NULL DEFAULT ''";

// ---- Romaji cache (Japanese lyrics romanization) ----
// One row per video: the Hepburn romaji for that song's lyric lines, aligned
// 1:1 with the lyrics we cached. Generated once via the LLM (see lib/romanize.ts)
// and reused (while `ver` matches), so a song is only romanised on first request.
db.exec(`
  CREATE TABLE IF NOT EXISTS romaji (
    videoId   TEXT PRIMARY KEY,
    data      TEXT NOT NULL,
    fetchedAt INTEGER NOT NULL
  );
`);
ensureColumn("romaji", "ver", VER_COLUMN);
ensureColumn("romaji", "src", SRC_COLUMN);

const getRomajiStmt = db.prepare(`SELECT data, ver, src FROM romaji WHERE videoId = ?`);

export function getCachedRomaji(videoId: string, src: string): string[] | null {
  const row = getRomajiStmt.get(videoId) as
    | { data: string; ver: number; src: string }
    | undefined;
  // Miss on a stale pipeline version OR on lyrics that aren't the ones this
  // romaji was generated from.
  if (!row || row.ver !== READING_CACHE_VERSION || row.src !== src) return null;
  return JSON.parse(row.data) as string[];
}

const putRomajiStmt = db.prepare(
  `INSERT INTO romaji (videoId, data, fetchedAt, ver, src)
   VALUES (@videoId, @data, @fetchedAt, @ver, @src)
   ON CONFLICT(videoId) DO UPDATE SET
     data = @data, fetchedAt = @fetchedAt, ver = @ver, src = @src`
);

export function putCachedRomaji(videoId: string, lines: string[], src: string): void {
  putRomajiStmt.run({
    src,
    videoId,
    data: JSON.stringify(lines),
    fetchedAt: Date.now(),
    ver: READING_CACHE_VERSION,
  });
}

// ---- Furigana cache (hiragana readings above Japanese lyrics) ----
// Like the romaji cache, but `data` is a JSON FuriganaSegment[][] (one segment
// array per lyric line). Generated once via the LLM (see lib/furigana.ts).
db.exec(`
  CREATE TABLE IF NOT EXISTS furigana (
    videoId   TEXT PRIMARY KEY,
    data      TEXT NOT NULL,
    fetchedAt INTEGER NOT NULL
  );
`);
ensureColumn("furigana", "ver", VER_COLUMN);
ensureColumn("furigana", "src", SRC_COLUMN);
// How many times we have generated/upgraded this row. A reading with gaps is
// still cached (see lib/furigana.ts) so the song stops re-running in full on
// every visit; this counter is what stops the gap-repair from re-asking
// forever when some lines simply refuse to come back annotated.
ensureColumn("furigana", "tries", "INTEGER NOT NULL DEFAULT 0");

const getFuriganaStmt = db.prepare(
  `SELECT data, ver, src, tries FROM furigana WHERE videoId = ?`
);

export type CachedFurigana = { segments: FuriganaSegment[][]; tries: number };

export function getCachedFurigana(
  videoId: string,
  src: string
): CachedFurigana | null {
  const row = getFuriganaStmt.get(videoId) as
    | { data: string; ver: number; src: string; tries: number }
    | undefined;
  if (!row || row.ver !== READING_CACHE_VERSION || row.src !== src) return null;
  return { segments: JSON.parse(row.data) as FuriganaSegment[][], tries: row.tries };
}

const putFuriganaStmt = db.prepare(
  `INSERT INTO furigana (videoId, data, fetchedAt, ver, src, tries)
   VALUES (@videoId, @data, @fetchedAt, @ver, @src, @tries)
   ON CONFLICT(videoId) DO UPDATE SET
     data = @data, fetchedAt = @fetchedAt, ver = @ver, src = @src, tries = @tries`
);

export function putCachedFurigana(
  videoId: string,
  lines: FuriganaSegment[][],
  src: string,
  tries: number
): void {
  putFuriganaStmt.run({
    src,
    tries,
    videoId,
    data: JSON.stringify(lines),
    fetchedAt: Date.now(),
    ver: READING_CACHE_VERSION,
  });
}

// ---- Translation cache (lyrics translated to a target language) ----
// Like the romaji cache, but keyed by (videoId, lang) because the same song has a
// different translation per target language. `data` is a JSON string[] aligned
// 1:1 with the lyric lines (see lib/translate.ts). Reused while `ver` matches.
db.exec(`
  CREATE TABLE IF NOT EXISTS translation (
    videoId   TEXT NOT NULL,
    lang      TEXT NOT NULL,
    data      TEXT NOT NULL,
    fetchedAt INTEGER NOT NULL,
    ver       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (videoId, lang)
  );
`);

ensureColumn("translation", "src", SRC_COLUMN);

const getTranslationStmt = db.prepare(
  `SELECT data, ver, src FROM translation WHERE videoId = ? AND lang = ?`
);

export function getCachedTranslation(
  videoId: string,
  lang: string,
  src: string
): string[] | null {
  const row = getTranslationStmt.get(videoId, lang) as
    | { data: string; ver: number; src: string }
    | undefined;
  if (!row || row.ver !== READING_CACHE_VERSION || row.src !== src) return null;
  return JSON.parse(row.data) as string[];
}

const putTranslationStmt = db.prepare(
  `INSERT INTO translation (videoId, lang, data, fetchedAt, ver, src)
   VALUES (@videoId, @lang, @data, @fetchedAt, @ver, @src)
   ON CONFLICT(videoId, lang) DO UPDATE SET
     data = @data, fetchedAt = @fetchedAt, ver = @ver, src = @src`
);

export function putCachedTranslation(
  videoId: string,
  lang: string,
  lines: string[],
  src: string
): void {
  putTranslationStmt.run({
    src,
    videoId,
    lang,
    data: JSON.stringify(lines),
    fetchedAt: Date.now(),
    ver: READING_CACHE_VERSION,
  });
}

// Drop the readings an older pipeline wrote, once, at startup.
//
// Strictly speaking this is housekeeping: every getCached* above already treats
// a `ver` mismatch as a miss, and the tables hold ONE row per song (the puts are
// ON CONFLICT(videoId) DO UPDATE), so a stale row is overwritten the next time
// that song is played and nothing accumulates. What it buys is the rows for
// songs nobody plays again — those would sit there holding wrong readings
// forever. Clearing them keeps the tables honest: everything still in there is
// something the current pipeline produced.
//
// Safe to run on every boot and in every process: it only deletes rows that are
// already unreadable, so a second run finds nothing.
for (const table of ["romaji", "furigana", "translation"]) {
  const { changes } = db
    .prepare(`DELETE FROM ${table} WHERE ver != ?`)
    .run(READING_CACHE_VERSION);
  if (changes > 0) {
    console.log(`[db] dropped ${changes} ${table} row(s) from an older reading pipeline`);
  }
}

// ---- AI free-use quota ----
// How many AI calls an identity has spent on the SERVER's shared OrcaRouter key.
// `id` is the signed-in user id when available, else a per-device guest id.
// Only real model calls (cache misses) bump this; a user's OWN key and the
// owner's bypass secret aren't counted (see lib/aiCall.ts). Survives restarts so
// the limit is per-account/per-device, not per-process.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id      TEXT PRIMARY KEY,
    count   INTEGER NOT NULL DEFAULT 0,
    firstAt INTEGER NOT NULL,
    lastAt  INTEGER NOT NULL
  );
`);

const aiUsageStmt = db.prepare(`SELECT count FROM ai_usage WHERE id = ?`);
export function aiUsageCount(id: string): number {
  const row = aiUsageStmt.get(id) as { count: number } | undefined;
  return row?.count ?? 0;
}

const bumpAiUsageStmt = db.prepare(
  `INSERT INTO ai_usage (id, count, firstAt, lastAt)
   VALUES (@id, 1, @at, @at)
   ON CONFLICT(id) DO UPDATE SET count = count + 1, lastAt = @at`
);
export function bumpAiUsage(id: string): void {
  bumpAiUsageStmt.run({ id, at: Date.now() });
}

// ---- Reference pitch contour cache (Tier 3 karaoke target line) ----
// One row per video: the song's own pitch line, generated once (yt-dlp+ffmpeg →
// pitch detection, see lib/reference.ts) and reused forever. Stored as a bare
// midi array (t is derivable from the index and fps) to keep it compact.
db.exec(`
  CREATE TABLE IF NOT EXISTS reference_pitch (
    videoId   TEXT PRIMARY KEY,
    fps       INTEGER NOT NULL,
    data      TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
`);

const getContourStmt = db.prepare(
  `SELECT fps, data FROM reference_pitch WHERE videoId = ?`
);

export function getCachedContour(
  videoId: string
): { fps: number; midis: number[] } | null {
  const row = getContourStmt.get(videoId) as
    | { fps: number; data: string }
    | undefined;
  if (!row) return null;
  return { fps: row.fps, midis: JSON.parse(row.data) as number[] };
}

const putContourStmt = db.prepare(
  `INSERT INTO reference_pitch (videoId, fps, data, createdAt)
   VALUES (@videoId, @fps, @data, @createdAt)
   ON CONFLICT(videoId) DO UPDATE SET
     fps = @fps, data = @data, createdAt = @createdAt`
);

export function putCachedContour(
  videoId: string,
  fps: number,
  midis: number[]
): void {
  putContourStmt.run({
    videoId,
    fps,
    // -1 stays -1 (unvoiced); voiced values keep 2 decimals to shrink the blob.
    data: JSON.stringify(
      midis.map((m) => (m < 0 ? -1 : Math.round(m * 100) / 100))
    ),
    createdAt: Date.now(),
  });
}

// ---- Pending-contour queue (offload mode) ----
// Videos that still need a contour, for the off-cluster worker to pull. This
// MUST live in SQLite, not an in-memory Set: the Socket.IO server (which marks
// videos on queue:add) and the Next.js API routes (which the worker polls) run
// as SEPARATE module instances in the custom-server setup, so they don't share
// in-process state — only the DB file is common ground.
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_contour (
    videoId   TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL
  );
`);

const markPendingStmt = db.prepare(
  `INSERT OR IGNORE INTO pending_contour (videoId, createdAt) VALUES (?, ?)`
);
export function markPendingContour(videoId: string): void {
  markPendingStmt.run(videoId, Date.now());
}

// Videos wanting a contour that aren't cached yet, oldest first.
const listPendingStmt = db.prepare(
  `SELECT p.videoId AS videoId FROM pending_contour p
   LEFT JOIN reference_pitch r ON r.videoId = p.videoId
   WHERE r.videoId IS NULL
   ORDER BY p.createdAt ASC`
);
export function listPendingContours(): string[] {
  return (listPendingStmt.all() as { videoId: string }[]).map((r) => r.videoId);
}

const clearPendingStmt = db.prepare(
  `DELETE FROM pending_contour WHERE videoId = ?`
);
export function clearPendingContour(videoId: string): void {
  clearPendingStmt.run(videoId);
}

export default db;
