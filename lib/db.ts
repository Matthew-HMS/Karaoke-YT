// SQLite persistence for the one thing that should outlive a server restart and
// belongs to a person: each user's starred favorites. (Per-room "recent" is now
// in-memory on the room itself — see lib/rooms.ts — since rooms are ephemeral.)
// One file on disk — perfect for a single VM, no external service.

import Database from "better-sqlite3";
import path from "path";
import type { LyricsResult } from "@/lib/types";

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

export default db;
