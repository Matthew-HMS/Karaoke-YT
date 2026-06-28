import { describe, expect, it } from "vitest";
import {
  addToQueue,
  advanceQueue,
  createRoom,
  deleteRoom,
  generateRoomCode,
  getOrCreateRoom,
  getRoom,
  reapIdleRooms,
  removeFromQueue,
  reorderQueue,
  setPlayerState,
  toRoomState,
  touchRoom,
} from "@/lib/rooms";

// The rooms store is a module-level Map, so each test uses a unique code to
// stay isolated.
let n = 0;
const code = () => `T${(n++).toString(36).toUpperCase().padStart(3, "0")}`;

const song = (title: string) => ({
  videoId: `vid-${title}`,
  title,
  thumbnail: "t",
  durationSec: 100,
  singer: "Sho",
});

describe("createRoom / getRoom / getOrCreateRoom", () => {
  it("creates a room with sensible defaults", () => {
    const c = code();
    const room = createRoom(c, "PW12");
    expect(room.code).toBe(c);
    expect(room.password).toBe("PW12");
    expect(room.queue).toEqual([]);
    expect(room.nowPlaying).toBeNull();
    expect(room.history).toEqual([]);
    expect(room.playerState.status).toBe("idle");
    expect(getRoom(c)).toBe(room);
  });

  it("getRoom returns undefined for an unknown code", () => {
    expect(getRoom("NOPE")).toBeUndefined();
  });

  it("getOrCreateRoom creates once then returns the same room", () => {
    const c = code();
    const a = getOrCreateRoom(c, "X");
    const b = getOrCreateRoom(c, "ignored");
    expect(a).toBe(b);
    expect(a.password).toBe("X"); // not overwritten on the second call
  });
});

describe("generateRoomCode", () => {
  it("returns a unique 4-char code", () => {
    const a = generateRoomCode();
    expect(a).toHaveLength(4);
    // Reserve it, then ensure the next code differs.
    createRoom(a);
    expect(generateRoomCode()).not.toBe(a);
  });
});

describe("queue operations", () => {
  it("auto-promotes the first added song to nowPlaying", () => {
    const room = createRoom(code());
    const entry = addToQueue(room, song("A"), "guest-1");
    expect(entry.id).toBeTruthy();
    expect(entry.addedBy).toBe("guest-1");
    expect(room.nowPlaying?.title).toBe("A");
    expect(room.queue).toHaveLength(0); // promoted out of the queue
    expect(room.playerState.status).toBe("playing");
  });

  it("keeps later songs in the queue", () => {
    const room = createRoom(code());
    addToQueue(room, song("A"), "g1");
    addToQueue(room, song("B"), "g2");
    addToQueue(room, song("C"), "g3");
    expect(room.nowPlaying?.title).toBe("A");
    expect(room.queue.map((q) => q.title)).toEqual(["B", "C"]);
  });

  it("removeFromQueue drops a single item by id", () => {
    const room = createRoom(code());
    addToQueue(room, song("A"), "g1");
    const b = addToQueue(room, song("B"), "g2");
    addToQueue(room, song("C"), "g3");
    removeFromQueue(room, b.id);
    expect(room.queue.map((q) => q.title)).toEqual(["C"]);
  });

  it("reorderQueue applies the given order and appends leftovers", () => {
    const room = createRoom(code());
    addToQueue(room, song("A"), "g1"); // becomes nowPlaying
    const b = addToQueue(room, song("B"), "g2");
    const c = addToQueue(room, song("C"), "g3");
    const d = addToQueue(room, song("D"), "g4");
    // Only mention C and B; D is a leftover and should be appended last.
    reorderQueue(room, [c.id, b.id]);
    expect(room.queue.map((q) => q.title)).toEqual(["C", "B", "D"]);
    expect(d).toBeTruthy();
  });
});

describe("advanceQueue", () => {
  it("moves the head to nowPlaying and pushes the old song into history", () => {
    const room = createRoom(code());
    addToQueue(room, song("A"), "g1"); // A now playing
    addToQueue(room, song("B"), "g2");
    const started = advanceQueue(room);
    expect(started?.title).toBe("B");
    expect(room.nowPlaying?.title).toBe("B");
    expect(room.history.map((h) => h.title)).toEqual(["A"]); // most-recent first
    expect(room.playerState.status).toBe("playing");
  });

  it("goes idle with null nowPlaying when the queue is empty", () => {
    const room = createRoom(code());
    addToQueue(room, song("A"), "g1");
    advanceQueue(room); // queue empty after this
    expect(room.nowPlaying).toBeNull();
    expect(room.playerState.status).toBe("idle");
    expect(room.history.map((h) => h.title)).toEqual(["A"]);
  });

  it("caps history at 50 entries, most-recent first", () => {
    const room = createRoom(code());
    for (let i = 0; i < 60; i++) {
      addToQueue(room, song(`S${i}`), "g");
      advanceQueue(room);
    }
    expect(room.history).toHaveLength(50);
    expect(room.history[0].title).toBe("S59"); // newest at the front
  });
});

describe("idle-room reaping", () => {
  it("deleteRoom removes a room", () => {
    const c = code();
    createRoom(c);
    expect(deleteRoom(c)).toBe(true);
    expect(getRoom(c)).toBeUndefined();
    expect(deleteRoom(c)).toBe(false); // already gone
  });

  it("touchRoom refreshes lastActivityAt", () => {
    const room = createRoom(code());
    room.lastActivityAt = 0;
    touchRoom(room);
    expect(room.lastActivityAt).toBeGreaterThan(0);
  });

  it("reaps rooms that are empty and idle past the TTL", () => {
    const c = code();
    const room = createRoom(c);
    room.lastActivityAt = 1000;
    const TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
    const now = 1000 + TTL + 1; // just past the TTL
    const removed = reapIdleRooms(TTL, () => false, now);
    expect(removed).toContain(c);
    expect(getRoom(c)).toBeUndefined();
  });

  it("keeps rooms that still have connected clients, even if idle", () => {
    const c = code();
    const room = createRoom(c);
    room.lastActivityAt = 1000;
    const TTL = 3 * 24 * 60 * 60 * 1000;
    const now = 1000 + TTL + 1;
    // hasClients returns true for this code → never reaped.
    const removed = reapIdleRooms(TTL, (x) => x === c, now);
    expect(removed).not.toContain(c);
    expect(getRoom(c)).toBeDefined();
  });

  it("keeps empty rooms that are still within the TTL", () => {
    const c = code();
    const room = createRoom(c);
    room.lastActivityAt = 1000;
    const TTL = 3 * 24 * 60 * 60 * 1000;
    const now = 1000 + TTL - 1; // not quite expired
    const removed = reapIdleRooms(TTL, () => false, now);
    expect(removed).not.toContain(c);
    expect(getRoom(c)).toBeDefined();
  });
});

describe("setPlayerState / toRoomState", () => {
  it("setPlayerState replaces the player state", () => {
    const room = createRoom(code());
    setPlayerState(room, { status: "paused", currentTimeSec: 12, durationSec: 200 });
    expect(room.playerState).toEqual({
      status: "paused",
      currentTimeSec: 12,
      durationSec: 200,
    });
  });

  it("toRoomState exposes the client-facing shape (no password)", () => {
    const room = createRoom(code(), "SECRET");
    addToQueue(room, song("A"), "g1");
    const state = toRoomState(room);
    expect(Object.keys(state).sort()).toEqual(
      ["code", "history", "nowPlaying", "playerState", "queue"].sort()
    );
    expect("password" in state).toBe(false);
  });
});
