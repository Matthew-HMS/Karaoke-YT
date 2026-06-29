import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addFavorite,
  getCachedLyrics,
  getKnownVideoIds,
  listFavorites,
  listTopPlayed,
  clearRejectedLyrics,
  putCachedLyrics,
  recordPlay,
  rejectLyrics,
  removeFavorite,
  setLyricsOffset,
  type SongMeta,
} from "@/lib/db";
import type { LyricsResult } from "@/lib/types";

// Each test uses a unique userId so the shared in-memory DB stays isolated.
let n = 0;
const user = () => `user-${n++}`;

const song = (id: string): SongMeta => ({
  videoId: id,
  title: `Title ${id}`,
  thumbnail: `thumb-${id}`,
  durationSec: 123,
});

describe("favorites", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adds and lists favorites (newest first by default)", () => {
    // Control the clock so the two rows get distinct starredAt values (real
    // Date.now() can tie within the same millisecond, making order ambiguous).
    const now = vi.spyOn(Date, "now");
    const u = user();
    now.mockReturnValue(1000);
    addFavorite(u, song("a"));
    now.mockReturnValue(2000);
    addFavorite(u, song("b"));
    const list = listFavorites(u);
    expect(list.map((s) => s.videoId)).toEqual(["b", "a"]);
    expect(list[0]).toEqual(song("b")); // full SongMeta shape round-trips
  });

  it("is idempotent — re-adding the same song does not duplicate", () => {
    const u = user();
    addFavorite(u, song("a"));
    addFavorite(u, { ...song("a"), title: "changed" });
    const list = listFavorites(u);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Title a"); // ON CONFLICT DO NOTHING keeps original
  });

  it("removeFavorite deletes only the given song for that user", () => {
    const u = user();
    addFavorite(u, song("a"));
    addFavorite(u, song("b"));
    removeFavorite(u, "a");
    expect(listFavorites(u).map((s) => s.videoId)).toEqual(["b"]);
  });

  it("scopes favorites per user", () => {
    const u1 = user();
    const u2 = user();
    addFavorite(u1, song("a"));
    expect(listFavorites(u1).map((s) => s.videoId)).toEqual(["a"]);
    expect(listFavorites(u2)).toEqual([]);
  });
});

describe("play counts + plays sort", () => {
  it("recordPlay increments and sorts favorites by play count", () => {
    const u = user();
    addFavorite(u, song("a"));
    addFavorite(u, song("b"));
    addFavorite(u, song("c"));

    // b played twice, c once, a never.
    recordPlay(u, "b");
    recordPlay(u, "b");
    recordPlay(u, "c");

    const byPlays = listFavorites(u, "plays");
    expect(byPlays.map((s) => s.videoId)).toEqual(["b", "c", "a"]);
  });

  it("keeps zero-play favorites visible in the plays sort (LEFT JOIN)", () => {
    const u = user();
    addFavorite(u, song("a"));
    const byPlays = listFavorites(u, "plays");
    expect(byPlays.map((s) => s.videoId)).toEqual(["a"]);
  });
});

describe("recommendation seeds", () => {
  it("listTopPlayed returns ids busiest-first, capped to the limit", () => {
    const u = user();
    recordPlay(u, "a");
    recordPlay(u, "b");
    recordPlay(u, "b");
    recordPlay(u, "c");
    recordPlay(u, "c");
    recordPlay(u, "c");
    expect(listTopPlayed(u, 2)).toEqual(["c", "b"]);
  });

  it("getKnownVideoIds unions favorites and plays for the user", () => {
    const u = user();
    addFavorite(u, song("fav"));
    recordPlay(u, "played");
    recordPlay(u, "fav"); // overlap shouldn't duplicate
    const known = getKnownVideoIds(u);
    expect(known).toEqual(new Set(["fav", "played"]));
  });

  it("scopes known ids per user", () => {
    const u1 = user();
    const u2 = user();
    addFavorite(u1, song("x"));
    expect(getKnownVideoIds(u2).size).toBe(0);
  });
});

describe("lyrics cache + sync offset", () => {
  const result: LyricsResult = {
    synced: true,
    source: "lrclib",
    lines: [{ timeSec: 1, text: "hi" }],
  };

  it("returns null for a video never looked up", () => {
    expect(getCachedLyrics("never")).toBeNull();
  });

  it("round-trips a cached hit with a default zero offset", () => {
    putCachedLyrics("vid-hit", result);
    const cached = getCachedLyrics("vid-hit");
    expect(cached?.result).toEqual(result);
    expect(cached?.offset).toBe(0);
  });

  it("caches a miss as a null result", () => {
    putCachedLyrics("vid-miss", null);
    const cached = getCachedLyrics("vid-miss");
    expect(cached).not.toBeNull();
    expect(cached?.result).toBeNull();
  });

  it("persists a sync offset and preserves it across a re-fetch", () => {
    putCachedLyrics("vid-off", result);
    setLyricsOffset("vid-off", 2.5);
    expect(getCachedLyrics("vid-off")?.offset).toBe(2.5);
    // Re-fetching the same video must not wipe the user's nudge.
    putCachedLyrics("vid-off", result);
    expect(getCachedLyrics("vid-off")?.offset).toBe(2.5);
  });

  it("can set an offset before lyrics are cached (upsert)", () => {
    setLyricsOffset("vid-early", -1.5);
    const cached = getCachedLyrics("vid-early");
    expect(cached?.offset).toBe(-1.5);
    expect(cached?.result).toBeNull();
  });

  it("rejectLyrics records the signature, clears data, and forces a re-fetch", () => {
    putCachedLyrics("vid-bad", result);
    expect(getCachedLyrics("vid-bad")?.rejected).toEqual([]);
    rejectLyrics("vid-bad", "sig1");
    const cached = getCachedLyrics("vid-bad");
    expect(cached?.rejected).toContain("sig1");
    expect(cached?.result).toBeNull(); // wrong lyrics cleared
    expect(cached?.fetchedAt).toBe(0); // miss expired → next lookup re-queries
  });

  it("rejectLyrics accumulates signatures across reports (de-duped)", () => {
    rejectLyrics("vid-acc", "a");
    rejectLyrics("vid-acc", "b");
    rejectLyrics("vid-acc", "a"); // duplicate ignored
    expect(getCachedLyrics("vid-acc")?.rejected).toEqual(["a", "b"]);
  });

  it("clearRejectedLyrics recovers a mistaken report", () => {
    rejectLyrics("vid-oops", "x");
    clearRejectedLyrics("vid-oops");
    expect(getCachedLyrics("vid-oops")?.rejected).toEqual([]);
  });
});
