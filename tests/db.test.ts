import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addFavorite,
  listFavorites,
  recordPlay,
  removeFavorite,
  type SongMeta,
} from "@/lib/db";

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
