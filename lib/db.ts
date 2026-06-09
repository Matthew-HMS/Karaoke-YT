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

const listFavStmt = db.prepare(
  `SELECT videoId, title, thumbnail, durationSec FROM favorite
   WHERE userId = ? ORDER BY starredAt DESC`
);

export function listFavorites(userId: string): SongMeta[] {
  return listFavStmt.all(userId) as SongMeta[];
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
