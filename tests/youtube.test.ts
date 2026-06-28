import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractPlaylistId,
  extractVideoId,
  getVideoMeta,
  parseDuration,
  searchYouTube,
} from "@/lib/youtube";

const VID = "dQw4w9WgXcQ"; // a real 11-char id shape

describe("extractVideoId", () => {
  it("accepts a bare 11-char id", () => {
    expect(extractVideoId(VID)).toBe(VID);
    expect(extractVideoId(`  ${VID}  `)).toBe(VID);
  });

  it("parses every common URL shape", () => {
    expect(extractVideoId(`https://youtu.be/${VID}`)).toBe(VID);
    expect(extractVideoId(`https://youtu.be/${VID}?t=43`)).toBe(VID);
    expect(extractVideoId(`https://www.youtube.com/watch?v=${VID}`)).toBe(VID);
    expect(extractVideoId(`https://m.youtube.com/watch?v=${VID}`)).toBe(VID);
    expect(extractVideoId(`https://www.youtube.com/watch?v=${VID}&list=PL1`)).toBe(VID);
    expect(extractVideoId(`https://www.youtube.com/embed/${VID}`)).toBe(VID);
    expect(extractVideoId(`https://www.youtube.com/shorts/${VID}`)).toBe(VID);
    expect(extractVideoId(`https://www.youtube.com/live/${VID}`)).toBe(VID);
  });

  it("returns null for non-YouTube or malformed input", () => {
    expect(extractVideoId("not a url")).toBeNull();
    expect(extractVideoId(`https://example.com/watch?v=${VID}`)).toBeNull();
    expect(extractVideoId("https://youtu.be/short")).toBeNull();
    expect(extractVideoId("")).toBeNull();
  });
});

describe("extractPlaylistId", () => {
  it("pulls a real playlist id", () => {
    expect(
      extractPlaylistId("https://www.youtube.com/playlist?list=PLabc123")
    ).toBe("PLabc123");
    expect(
      extractPlaylistId(`https://www.youtube.com/watch?v=${VID}&list=PLxyz`)
    ).toBe("PLxyz");
  });

  it("ignores auto-generated radio/mix lists", () => {
    expect(
      extractPlaylistId(`https://www.youtube.com/watch?v=${VID}&list=RD123`)
    ).toBeNull();
    expect(
      extractPlaylistId(`https://www.youtube.com/watch?v=${VID}&list=UL123`)
    ).toBeNull();
  });

  it("returns null when there is no list or it isn't a URL", () => {
    expect(extractPlaylistId(`https://www.youtube.com/watch?v=${VID}`)).toBeNull();
    expect(extractPlaylistId("nonsense")).toBeNull();
  });
});

describe("parseDuration", () => {
  it("parses ISO-8601 durations to seconds", () => {
    expect(parseDuration("PT3M20S")).toBe(200);
    expect(parseDuration("PT1H2M3S")).toBe(3723);
    expect(parseDuration("PT45S")).toBe(45);
    expect(parseDuration("PT10M")).toBe(600);
    expect(parseDuration("PT2H")).toBe(7200);
  });

  it("returns 0 for empty or unparseable input", () => {
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("garbage")).toBe(0);
  });
});

describe("youtube data API helpers (mocked fetch)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("getVideoMeta maps snippet + duration, preferring the medium thumb", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            {
              id: VID,
              snippet: {
                title: "Song",
                thumbnails: { medium: { url: "http://m" }, high: { url: "http://h" } },
              },
              contentDetails: { duration: "PT3M20S" },
            },
          ],
        }),
      }))
    );

    const meta = await getVideoMeta(VID);
    expect(meta).toEqual({
      videoId: VID,
      title: "Song",
      thumbnail: "http://m",
      durationSec: 200,
    });
  });

  it("getVideoMeta returns null when the id isn't found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }))
    );
    expect(await getVideoMeta(VID)).toBeNull();
  });

  it("getVideoMeta throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    );
    await expect(getVideoMeta(VID)).rejects.toThrow(/500/);
  });

  it("throws a clear error when YOUTUBE_API_KEY is missing", async () => {
    vi.stubEnv("YOUTUBE_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn());
    await expect(getVideoMeta(VID)).rejects.toThrow(/YOUTUBE_API_KEY/);
  });

  it("searchYouTube enriches results and preserves search order", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.includes("/search")) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: { videoId: "id1" } }, { id: { videoId: "id2" } }],
          }),
        };
      }
      // /videos — return out of order to prove order is restored from search.
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: "id2",
              snippet: { title: "Two", thumbnails: { default: { url: "u2" } } },
              contentDetails: { duration: "PT1M" },
            },
            {
              id: "id1",
              snippet: { title: "One", thumbnails: { high: { url: "u1" } } },
              contentDetails: { duration: "PT2M" },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchYouTube("abba", { karaokeOnly: true, limit: 5 });
    expect(results.map((r) => r.videoId)).toEqual(["id1", "id2"]);
    expect(results[0]).toEqual({
      videoId: "id1",
      title: "One",
      thumbnail: "u1",
      durationSec: 120,
    });
    // karaokeOnly augments the query sent to the search endpoint.
    expect(String(fetchMock.mock.calls[0][0])).toContain("karaoke");
  });
});
