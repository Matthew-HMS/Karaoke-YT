// Quota-free YouTube search via yt-dlp (the same tool pikaraoke uses). Spawns
// `yt-dlp "ytsearchN:<query>"` and parses the flat-playlist JSON. No API key,
// no daily quota. Requires the yt-dlp binary on PATH (or set YTDLP_PATH).

import { spawn } from "child_process";
import type { SearchResult } from "./youtube";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const MAX_RESULTS = 20;
const TIMEOUT_MS = 12000;

type FlatEntry = {
  id?: string;
  title?: string;
  duration?: number;
};

export function searchViaYtDlp(
  query: string,
  karaokeOnly: boolean
): Promise<SearchResult[]> {
  const q = karaokeOnly ? `${query} karaoke` : query;
  const term = `ytsearch${MAX_RESULTS}:${q}`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      YTDLP,
      [term, "--flat-playlist", "-J", "--no-warnings", "--no-playlist"],
      { timeout: TIMEOUT_MS }
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
