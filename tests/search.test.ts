import { describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/lib/youtube";

// Stub both search backends so the orchestrator can be tested in isolation.
vi.mock("@/lib/ytsearch", () => ({ searchViaYtDlp: vi.fn() }));
vi.mock("@/lib/youtube", () => ({ searchYouTube: vi.fn() }));

import { searchSongs } from "@/lib/search";
import { searchViaYtDlp } from "@/lib/ytsearch";
import { searchYouTube } from "@/lib/youtube";

const ytdlp = vi.mocked(searchViaYtDlp);
const api = vi.mocked(searchYouTube);

const r = (id: string): SearchResult => ({
  videoId: id,
  title: id,
  thumbnail: "t",
  durationSec: 1,
});

describe("searchSongs", () => {
  it("uses yt-dlp when it succeeds", async () => {
    ytdlp.mockResolvedValue([r("a"), r("b")]);
    const out = await searchSongs("query-yt", { karaokeOnly: false, limit: 20 });
    expect(out.source).toBe("yt-dlp");
    expect(out.results.map((x) => x.videoId)).toEqual(["a", "b"]);
    expect(api).not.toHaveBeenCalled();
  });

  it("serves a repeated identical query from cache", async () => {
    ytdlp.mockResolvedValue([r("a")]);
    const first = await searchSongs("query-cache", { karaokeOnly: true, limit: 20 });
    const second = await searchSongs("query-cache", { karaokeOnly: true, limit: 20 });
    expect(first.source).toBe("yt-dlp");
    expect(second.source).toBe("cache");
    expect(second.results).toEqual(first.results);
    expect(ytdlp).toHaveBeenCalledTimes(1); // second hit didn't re-search
  });

  it("falls back to the YouTube API when yt-dlp throws", async () => {
    ytdlp.mockRejectedValue(new Error("yt-dlp missing"));
    api.mockResolvedValue([r("api1")]);
    const out = await searchSongs("query-fallback", { karaokeOnly: false, limit: 20 });
    expect(out.source).toBe("youtube-api");
    expect(out.results.map((x) => x.videoId)).toEqual(["api1"]);
    expect(api).toHaveBeenCalledOnce();
  });

  it("keys the cache by query + options (different limit re-searches)", async () => {
    ytdlp.mockResolvedValue([r("a")]);
    await searchSongs("query-key", { karaokeOnly: false, limit: 20 });
    await searchSongs("query-key", { karaokeOnly: false, limit: 40 });
    expect(ytdlp).toHaveBeenCalledTimes(2);
  });
});
