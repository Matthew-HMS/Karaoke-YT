// SQLite persistence for the one thing that should outlive a server restart and
// belongs to a person: each user's starred favorites. (Per-room "recent" is now
// in-memory on the room itself — see lib/rooms.ts — since rooms are ephemeral.)
// One file on disk — perfect for a single VM, no external service.

import Database from "better-sqlite3";
import path from "path";

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

export default db;
