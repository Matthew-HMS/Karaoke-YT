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
  queue: QueueItem[];
  nowPlaying: QueueItem | null;
  playerState: PlayerState;
  hostSocketId: string | null;
};

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

export function createRoom(code?: string): Room {
  const room: Room = {
    code: code ?? generateRoomCode(),
    queue: [],
    nowPlaying: null,
    playerState: { ...DEFAULT_PLAYER_STATE },
    hostSocketId: null,
  };
  rooms.set(room.code, room);
  return room;
}

// Get an existing room, or lazily create one for the given code. Lazy creation
// keeps things simple: visiting /host/ABCD or /r/ABCD just works.
export function getOrCreateRoom(code: string): Room {
  const existing = rooms.get(code);
  if (existing) return existing;
  return createRoom(code);
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
