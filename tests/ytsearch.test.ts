import { EventEmitter } from "node:events";
import { describe, expect, it, vi, type Mock } from "vitest";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "child_process";
import { getPlaylistViaYtDlp, searchViaYtDlp } from "@/lib/ytsearch";

const spawnMock = spawn as unknown as Mock;

// A stand-in for a spawned process: an EventEmitter with stdout/stderr streams.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("searchViaYtDlp", () => {
  it("parses flat-playlist JSON into SearchResults", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = searchViaYtDlp("abba", { karaokeOnly: false, limit: 5 });
    child.stdout.emit(
      "data",
      JSON.stringify({
        entries: [
          { id: "abc", title: "Song", duration: 200.6 },
          { title: "dropped — no id" },
          { id: "xyz", duration: 10 },
        ],
      })
    );
    child.emit("close", 0);

    const results = await promise;
    expect(results).toEqual([
      {
        videoId: "abc",
        title: "Song",
        thumbnail: "https://i.ytimg.com/vi/abc/mqdefault.jpg",
        durationSec: 201, // rounded
      },
      {
        videoId: "xyz",
        title: "Untitled", // missing title falls back
        thumbnail: "https://i.ytimg.com/vi/xyz/mqdefault.jpg",
        durationSec: 10,
      },
    ]);
  });

  it("appends 'karaoke' to the query when karaokeOnly is set", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const promise = searchViaYtDlp("abba", { karaokeOnly: true, limit: 5 });
    child.stdout.emit("data", JSON.stringify({ entries: [] }));
    child.emit("close", 0);
    await promise;
    const targetUrl = String(spawnMock.mock.calls[0][1][0]);
    expect(decodeURIComponent(targetUrl)).toContain("abba karaoke");
  });

  it("rejects when yt-dlp produces no output", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const promise = searchViaYtDlp("q", { karaokeOnly: false, limit: 5 });
    child.stderr.emit("data", "boom");
    child.emit("close", 1);
    await expect(promise).rejects.toThrow(/yt-dlp failed/);
  });

  it("rejects when the binary is missing (spawn error)", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const promise = searchViaYtDlp("q", { karaokeOnly: false, limit: 5 });
    child.emit("error", new Error("ENOENT"));
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  it("rejects on malformed JSON", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const promise = searchViaYtDlp("q", { karaokeOnly: false, limit: 5 });
    child.stdout.emit("data", "{not json");
    child.emit("close", 0);
    await expect(promise).rejects.toBeInstanceOf(Error);
  });
});

describe("getPlaylistViaYtDlp", () => {
  it("targets the playlist URL and parses entries", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const promise = getPlaylistViaYtDlp("PL123");
    child.stdout.emit(
      "data",
      JSON.stringify({ entries: [{ id: "p1", title: "First", duration: 60 }] })
    );
    child.emit("close", 0);

    const results = await promise;
    expect(results).toHaveLength(1);
    expect(results[0].videoId).toBe("p1");
    expect(String(spawnMock.mock.calls[0][1][0])).toContain(
      "playlist?list=PL123"
    );
  });
});
