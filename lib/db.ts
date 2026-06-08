// SQLite persistence for the two things that should outlive a server restart:
// played-song history and starred favorites. Everything else (live rooms) is
// in-memory. One file on disk — perfect for a single VM, no external service.

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import path from "path";

export type SongMeta = {
  videoId: string;
  title: string;
  thumbnail: string;
  durationSec: number;
};

const DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "singalong.db");

// Module-level singleton. Both the custom server and the Next API routes import
// this; each ends up with its own connection to the same file, which SQLite
// handles fine — WAL mode keeps concurrent reads/writes happy.
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id          TEXT PRIMARY KEY,
    videoId     TEXT NOT NULL,
    title       TEXT NOT NULL,
    thumbnail   TEXT NOT NULL,
    durationSec INTEGER NOT NULL,
    singer      TEXT NOT NULL,
    playedAt    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favorite (
    videoId     TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    thumbnail   TEXT NOT NULL,
    durationSec INTEGER NOT NULL,
    starredAt   INTEGER NOT NULL
  );
`);

const insertHistory = db.prepare(
  `INSERT INTO history (id, videoId, title, thumbnail, durationSec, singer, playedAt)
   VALUES (@id, @videoId, @title, @thumbnail, @durationSec, @singer, @playedAt)`
);

export function logPlay(song: SongMeta, singer: string): void {
  insertHistory.run({
    id: randomUUID(),
    ...song,
    singer,
    playedAt: Date.now(),
  });
}

// Most-recently played, de-duplicated by video (latest play wins).
const recentStmt = db.prepare(
  `SELECT videoId, title, thumbnail, durationSec, MAX(playedAt) AS playedAt
   FROM history GROUP BY videoId ORDER BY playedAt DESC LIMIT ?`
);

export function recentlyPlayed(limit = 30): SongMeta[] {
  return recentStmt.all(limit) as SongMeta[];
}

const listFavStmt = db.prepare(
  `SELECT videoId, title, thumbnail, durationSec FROM favorite
   ORDER BY starredAt DESC`
);

export function listFavorites(): SongMeta[] {
  return listFavStmt.all() as SongMeta[];
}

const addFavStmt = db.prepare(
  `INSERT INTO favorite (videoId, title, thumbnail, durationSec, starredAt)
   VALUES (@videoId, @title, @thumbnail, @durationSec, @starredAt)
   ON CONFLICT(videoId) DO NOTHING`
);

export function addFavorite(song: SongMeta): void {
  addFavStmt.run({ ...song, starredAt: Date.now() });
}

const removeFavStmt = db.prepare(`DELETE FROM favorite WHERE videoId = ?`);

export function removeFavorite(videoId: string): void {
  removeFavStmt.run(videoId);
}

export default db;
