// Quota-free YouTube search via yt-dlp (the same tool pikaraoke uses). Scrapes
// a YouTube results URL with `--flat-playlist -J`. No API key, no daily quota.
// Requires the yt-dlp binary on PATH (or set YTDLP_PATH).

import { spawn } from "child_process";
import type { SearchResult } from "./youtube";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const MAX_PLAYLIST = 50; // don't let one playlist flood the queue
const PLAYLIST_TIMEOUT_MS = 25000;

// YouTube "sp" filter code for "relevance + type=video" (so flat entries are
// videos, not channels/playlists).
const SP_VIDEO = "CAASAhAB";

type FlatEntry = {
  id?: string;
  title?: string;
  duration?: number;
};

// Run yt-dlp with `--flat-playlist -J` against a URL and parse the flat entries.
function runFlat(
  target: string,
  limit: number,
  timeout: number
): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      YTDLP,
      [
        target,
        "--flat-playlist",
        "-J",
        "--no-warnings",
        "--playlist-end",
        String(limit),
      ],
      { timeout }
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    // Fires when the binary is missing (ENOENT) etc. → triggers API fallback.
    child.on("error", reject);

    child.on("close", (code) => {
      if (!out) {
        reject(new Error(`yt-dlp failed (code ${code}): ${err.slice(0, 200)}`));
        return;
      }
      try {
        const data = JSON.parse(out) as { entries?: FlatEntry[] };
        const results: SearchResult[] = (data.entries ?? [])
          .filter((e): e is FlatEntry & { id: string } => Boolean(e?.id))
          .map((e) => ({
            videoId: e.id,
            title: e.title ?? "Untitled",
            thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
            durationSec: Math.round(e.duration ?? 0),
          }));
        resolve(results);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function searchViaYtDlp(
  query: string,
  opts: { karaokeOnly: boolean; limit: number }
): Promise<SearchResult[]> {
  const q = opts.karaokeOnly ? `${query} karaoke` : query;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    q
  )}&sp=${SP_VIDEO}`;
  // A little headroom on the timeout for larger result sets.
  return runFlat(url, opts.limit, 10000 + opts.limit * 120);
}

// Fetch a playlist's videos (capped) via yt-dlp.
export async function getPlaylistViaYtDlp(
  playlistId: string
): Promise<SearchResult[]> {
  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  return runFlat(url, MAX_PLAYLIST, PLAYLIST_TIMEOUT_MS);
}

// Fetch a video's auto-generated "Mix" (the radio playlist YouTube builds from a
// seed video, id `RD<videoId>`). This is YouTube's own per-song related-songs
// feed — quota-free via the watch URL. The seed video itself is filtered out.
export async function getRelatedViaYtDlp(
  videoId: string,
  limit = 25
): Promise<SearchResult[]> {
  const url = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
  const results = await runFlat(url, limit, PLAYLIST_TIMEOUT_MS);
  return results.filter((r) => r.videoId !== videoId);
}
