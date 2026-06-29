import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/lib/youtube";

// Mock every external dependency so these tests exercise only the recommender's
// own orchestration/scoring logic (no yt-dlp, no DB, no network).
const mocks = vi.hoisted(() => ({
  searchSongs: vi.fn(),
  getPlaylistViaYtDlp: vi.fn(),
  getRelatedViaYtDlp: vi.fn(),
  getMostPopularMusic: vi.fn(),
  getKnownVideoIds: vi.fn(),
  listFavorites: vi.fn(),
  listTopPlayed: vi.fn(),
}));

vi.mock("@/lib/search", () => ({ searchSongs: mocks.searchSongs }));
vi.mock("@/lib/ytsearch", () => ({
  getPlaylistViaYtDlp: mocks.getPlaylistViaYtDlp,
  getRelatedViaYtDlp: mocks.getRelatedViaYtDlp,
}));
vi.mock("@/lib/youtube", () => ({ getMostPopularMusic: mocks.getMostPopularMusic }));
vi.mock("@/lib/db", () => ({
  getKnownVideoIds: mocks.getKnownVideoIds,
  listFavorites: mocks.listFavorites,
  listTopPlayed: mocks.listTopPlayed,
}));

const song = (
  id: string,
  durationSec = 100,
  title = `Title ${id}`
): SearchResult => ({
  videoId: id,
  title,
  thumbnail: `thumb-${id}`,
  durationSec,
});

// Fresh module (and thus fresh in-process caches) per test.
async function load() {
  return import("@/lib/recommend");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Sensible defaults; individual tests override as needed.
  mocks.getKnownVideoIds.mockReturnValue(new Set<string>());
  mocks.listFavorites.mockReturnValue([]);
  mocks.listTopPlayed.mockReturnValue([]);
  // Default: no chart results, so trending tests fall through to the curated path
  // unless a test opts into the chart.
  mocks.getMostPopularMusic.mockResolvedValue([]);
});

describe("getRelated", () => {
  it("returns the Mix radio results", async () => {
    mocks.getRelatedViaYtDlp.mockResolvedValue([song("a"), song("b")]);
    const { getRelated } = await load();
    const res = await getRelated("seed");
    expect(res.map((r) => r.videoId)).toEqual(["a", "b"]);
  });

  it("caches per videoId (second call doesn't re-scrape)", async () => {
    mocks.getRelatedViaYtDlp.mockResolvedValue([song("a")]);
    const { getRelated } = await load();
    await getRelated("seed");
    await getRelated("seed");
    expect(mocks.getRelatedViaYtDlp).toHaveBeenCalledTimes(1);
  });

  it("falls back to a cleaned-title search when the mix is empty", async () => {
    mocks.getRelatedViaYtDlp.mockResolvedValue([]);
    mocks.searchSongs.mockResolvedValue({ results: [song("c")], source: "yt-dlp" });
    const { getRelated } = await load();
    const res = await getRelated("seed", "Artist - Song (Official Video) karaoke");
    expect(res.map((r) => r.videoId)).toEqual(["c"]);
    // Bracketed tags + "karaoke" are stripped from the fallback query.
    expect(mocks.searchSongs).toHaveBeenCalledWith(
      "Artist - Song",
      expect.objectContaining({ karaokeOnly: false })
    );
  });
});

describe("getTrending", () => {
  it("blends curated songs with the live chart, capping the chart at ~30%", async () => {
    // Chart: real current hits (Chinese-titled here so they don't affect the
    // Chinese floor); ids start with "ch" so the test can count them.
    mocks.getMostPopularMusic.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => song(`ch${i}`, 200, `華語新歌${i}`))
    );
    // Curated: each name search returns one unique song (title = the query).
    mocks.searchSongs.mockImplementation((q: string) =>
      Promise.resolve({ results: [song(`cur:${q}`, 200, q)], source: "yt-dlp" })
    );

    const { getTrending } = await load();
    const res = await getTrending();

    expect(res.length).toBe(25);
    const chartCount = res.filter((r) => /^ch\d/.test(r.videoId)).length;
    const curatedCount = res.filter((r) => r.videoId.startsWith("cur:")).length;
    // Both sources represented; chart held to ~30%.
    expect(chartCount).toBeGreaterThan(0);
    expect(curatedCount).toBeGreaterThan(0);
    expect(chartCount).toBeLessThanOrEqual(Math.round(25 * 0.3));
  });

  it("keeps the feed ≥70% Chinese even when non-Chinese songs are plentiful", async () => {
    // Chart-only (no curated), heavily non-Chinese. ids encode language so the
    // test counts reliably regardless of the title heuristic.
    mocks.getMostPopularMusic.mockResolvedValue([
      ...Array.from({ length: 8 }, (_, i) => song(`cn${i}`, 200, `中文${i}`)),
      ...Array.from({ length: 20 }, (_, i) => song(`en${i}`, 200, `English ${i}`)),
    ]);
    mocks.searchSongs.mockResolvedValue({ results: [], source: "yt-dlp" });

    const { getTrending } = await load();
    const res = await getTrending();

    const nonChinese = res.filter((r) => r.videoId.startsWith("en")).length;
    expect(res.length).toBeGreaterThan(0);
    expect(nonChinese / res.length).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it("falls back to the curated pool when the chart is empty (no key)", async () => {
    mocks.getMostPopularMusic.mockResolvedValue([]);
    mocks.searchSongs.mockResolvedValue({ results: [song("t1")], source: "yt-dlp" });
    const { getTrending } = await load();
    const res = await getTrending();
    expect(res.map((r) => r.videoId)).toEqual(["t1"]);
    expect(mocks.getPlaylistViaYtDlp).not.toHaveBeenCalled();
    expect(mocks.searchSongs).toHaveBeenCalled();
  });

  it("drops hour-long compilations and live streams (0-duration), keeps real songs", async () => {
    mocks.searchSongs.mockResolvedValue({
      results: [song("short", 200), song("mix", 3600), song("live", 0)],
      source: "yt-dlp",
    });
    const { getTrending } = await load();
    const res = await getTrending();
    expect(res.map((r) => r.videoId)).toEqual(["short"]);
  });
});

describe("getRecommendations", () => {
  it("ranks by cross-seed agreement and excludes known songs", async () => {
    mocks.listTopPlayed.mockReturnValue(["s1"]);
    mocks.listFavorites.mockReturnValue([
      { videoId: "s2", title: "Seed 2", thumbnail: "", durationSec: 0 },
    ]);
    mocks.getKnownVideoIds.mockReturnValue(new Set(["s1", "s2", "known"]));
    mocks.getRelatedViaYtDlp.mockImplementation(async (id: string) =>
      id === "s1"
        ? [song("x"), song("known")] // "known" must be filtered out
        : [song("x"), song("y")] // "x" surfaces from both seeds → ranked first
    );

    const { getRecommendations } = await load();
    const res = await getRecommendations("user");
    expect(res.map((r) => r.videoId)).toEqual(["x", "y"]);
  });

  it("returns trending when the user has no history", async () => {
    mocks.searchSongs.mockResolvedValue({ results: [song("t1")], source: "yt-dlp" });
    const { getRecommendations } = await load();
    const res = await getRecommendations("user");
    expect(res.map((r) => r.videoId)).toEqual(["t1"]);
    expect(mocks.getRelatedViaYtDlp).not.toHaveBeenCalled();
  });
});
