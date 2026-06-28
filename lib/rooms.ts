// Server-side, in-memory store of live karaoke rooms.
// Live room state (queue, now-playing, player position) is intentionally NOT
// persisted — a party is short-lived and resetting on restart is acceptable.
// Durable data (history, favorites) lives in SQLite instead (see lib/db.ts).

import { randomUUID } from "crypto";
import {
  DEFAULT_PLAYER_STATE,
  PlayerState,
  QueueItem,
  RoomState,
} from "./types";

type Room = {
  code: string;
  password: string; // 4-char join password set by the host
  queue: QueueItem[];
  nowPlaying: QueueItem | null;
  playerState: PlayerState;
  history: QueueItem[]; // played songs (most-recent first), capped, in-memory
  hostSocketId: string | null;
  lastActivityAt: number; // epoch ms; bumped on activity, used to reap idle rooms
};

const MAX_HISTORY = 50;

const rooms = new Map<string, Room>();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no easily-confused chars

export function generateRoomCode(): string {
  let code: string;
  do {
    code = Array.from(
      { length: 4 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

export function createRoom(code?: string, password = ""): Room {
  const room: Room = {
    code: code ?? generateRoomCode(),
    password,
    queue: [],
    nowPlaying: null,
    playerState: { ...DEFAULT_PLAYER_STATE },
    history: [],
    hostSocketId: null,
    lastActivityAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

// Mark a room as recently active so the idle reaper leaves it alone. Called on
// join and whenever the room's state changes (see server.ts).
export function touchRoom(room: Room): void {
  room.lastActivityAt = Date.now();
}

export function deleteRoom(code: string): boolean {
  return rooms.delete(code);
}

// Remove rooms that are both empty and stale: no connected clients (per the
// `hasClients` probe, which consults live Socket.IO membership) AND no activity
// for longer than `maxIdleMs`. Returns the codes that were removed. `now` is
// injectable for tests.
export function reapIdleRooms(
  maxIdleMs: number,
  hasClients: (code: string) => boolean,
  now: number = Date.now()
): string[] {
  const removed: string[] = [];
  for (const [code, room] of rooms) {
    if (hasClients(code)) continue; // someone's still connected — keep it
    if (now - room.lastActivityAt > maxIdleMs) {
      rooms.delete(code);
      removed.push(code);
    }
  }
  return removed;
}

// Get an existing room, or lazily create one for the given code. Only the host
// creates rooms (see server.ts); guests must join an existing one.
export function getOrCreateRoom(code: string, password = ""): Room {
  const existing = rooms.get(code);
  if (existing) return existing;
  return createRoom(code, password);
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code);
}

export function toRoomState(room: Room): RoomState {
  return {
    code: room.code,
    queue: room.queue,
    nowPlaying: room.nowPlaying,
    playerState: room.playerState,
    history: room.history,
  };
}

export function addToQueue(
  room: Room,
  item: Omit<QueueItem, "id" | "addedBy">,
  addedBy: string
): QueueItem {
  const entry: QueueItem = { ...item, id: randomUUID(), addedBy };
  room.queue.push(entry);
  // If nothing is playing, promote the first song immediately.
  if (!room.nowPlaying) advanceQueue(room);
  return entry;
}

export function removeFromQueue(room: Room, id: string): void {
  room.queue = room.queue.filter((q) => q.id !== id);
}

export function reorderQueue(room: Room, order: string[]): void {
  const byId = new Map(room.queue.map((q) => [q.id, q]));
  const next: QueueItem[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) {
      next.push(item);
      byId.delete(id);
    }
  }
  // Append any items not mentioned in `order` (defensive).
  for (const leftover of byId.values()) next.push(leftover);
  room.queue = next;
}

// Move the head of the queue into nowPlaying. Returns the song that started,
// or null if the queue was empty (player goes idle).
export function advanceQueue(room: Room): QueueItem | null {
  // The song that was playing is now part of this room's history.
  if (room.nowPlaying) {
    room.history = [room.nowPlaying, ...room.history].slice(0, MAX_HISTORY);
  }
  const next = room.queue.shift() ?? null;
  room.nowPlaying = next;
  room.playerState = {
    ...DEFAULT_PLAYER_STATE,
    status: next ? "playing" : "idle",
  };
  return next;
}

export function setPlayerState(room: Room, state: PlayerState): void {
  room.playerState = state;
}
