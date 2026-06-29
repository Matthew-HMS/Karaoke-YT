import { describe, expect, it } from "vitest";
import { nameScore, parseLrc, parseMusixmatch, parseTitle } from "@/lib/lyrics";

describe("parseTitle", () => {
  it("splits a clean 'Artist - Track' title", () => {
    expect(parseTitle("Adele - Hello")).toEqual({
      artist: "Adele",
      track: "Hello",
    });
  });

  it("strips bracketed noise and credits", () => {
    expect(parseTitle("Adele - Hello (Official Music Video) [4K]")).toEqual({
      artist: "Adele",
      track: "Hello",
    });
    expect(
      parseTitle("Eminem - Stan ft. Dido (Official Video)")
    ).toEqual({ artist: "Eminem", track: "Stan" });
  });

  it("handles full-width brackets and pipe separators", () => {
    expect(parseTitle("YOASOBI「アイドル」| Idol")).toMatchObject({
      track: expect.any(String),
    });
  });

  it("keeps everything after the first separator as the track", () => {
    expect(parseTitle("Queen - Bohemian Rhapsody - Remastered")).toEqual({
      artist: "Queen",
      track: "Bohemian Rhapsody",
    });
  });

  it("falls back to the whole string when there's no separator", () => {
    expect(parseTitle("Imagine")).toEqual({ track: "Imagine" });
  });

  it("pulls the track from inside CJK brackets, artist from before", () => {
    expect(
      parseTitle(
        "G.E.M.鄧紫棋【差不多姑娘 MISS SIMILAR 】Real Talk版 Official Music Video"
      )
    ).toEqual({ artist: "G.E.M.鄧紫棋", track: "差不多姑娘" });
  });

  it("drops a Latin translation alias from a CJK track name", () => {
    // The English alias would otherwise false-match unrelated English songs.
    expect(
      parseTitle(
        "G.E.M.【光年之外 LIGHT YEARS AWAY 】MV (電影《太空潛航者 Passengers》中文主題曲 鄧紫棋"
      )
    ).toEqual({ artist: "G.E.M.", track: "光年之外" });
  });
});

describe("parseLrc", () => {
  it("parses timestamped lines in order", () => {
    const lrc = "[00:12.34]First line\n[00:15.00]Second line";
    expect(parseLrc(lrc)).toEqual([
      { timeSec: 12.34, text: "First line" },
      { timeSec: 15, text: "Second line" },
    ]);
  });

  it("expands a line carrying multiple timestamps", () => {
    const lrc = "[00:01.00][00:05.00]Chorus";
    expect(parseLrc(lrc)).toEqual([
      { timeSec: 1, text: "Chorus" },
      { timeSec: 5, text: "Chorus" },
    ]);
  });

  it("normalises 2- and 3-digit fractional seconds and sorts", () => {
    const lrc = "[00:10.5]late\n[00:02.250]early";
    expect(parseLrc(lrc)).toEqual([
      { timeSec: 2.25, text: "early" },
      { timeSec: 10.5, text: "late" },
    ]);
  });

  it("ignores metadata-only tags and blank lines", () => {
    const lrc = "[ar:Artist]\n[ti:Title]\n\n[00:01.00]Only line";
    expect(parseLrc(lrc)).toEqual([{ timeSec: 1, text: "Only line" }]);
  });
});

describe("parseMusixmatch", () => {
  it("uses lrc_lyrics for synced results", () => {
    const res = parseMusixmatch({
      success: true,
      lrc_lyrics: "[00:00.61]First\n[00:04.57]Second",
      plain_lyrics: "First\nSecond",
    });
    expect(res).toEqual({
      synced: true,
      source: "musixmatch",
      lines: [
        { timeSec: 0.61, text: "First" },
        { timeSec: 4.57, text: "Second" },
      ],
    });
  });

  it("falls back to plain_lyrics when there's no LRC", () => {
    const res = parseMusixmatch({
      success: true,
      lrc_lyrics: null,
      plain_lyrics: "Line one\nLine two",
    });
    expect(res?.synced).toBe(false);
    expect(res?.lines.map((l) => l.text)).toEqual(["Line one", "Line two"]);
  });

  it("returns null on an unsuccessful response", () => {
    expect(parseMusixmatch({ success: false })).toBeNull();
    expect(parseMusixmatch({ success: true })).toBeNull();
  });
});

describe("nameScore", () => {
  it("scores an exact (normalised) match highest", () => {
    expect(nameScore("HALO", "halo")).toBe(3);
    expect(nameScore("Beyoncé", "Beyonce")).toBe(3); // diacritics ignored
    expect(nameScore("Hello!", "hello")).toBe(3); // punctuation ignored
  });

  it("scores a containment match in the middle", () => {
    expect(nameScore("Hello", "Hello (Remastered)")).toBe(2);
    expect(nameScore("bad luck live", "bad luck")).toBe(2);
  });

  it("scores unrelated names zero", () => {
    expect(nameScore("Hello", "Rolling in the Deep")).toBe(0);
    expect(nameScore("", "Hello")).toBe(0);
  });

  it("matches CJK names (not stripped to empty)", () => {
    expect(nameScore("差不多姑娘", "差不多姑娘")).toBe(3);
    expect(nameScore("差不多姑娘 MISS SIMILAR", "差不多姑娘")).toBe(2);
    expect(nameScore("G.E.M.鄧紫棋", "鄧紫棋")).toBe(2);
  });
});
