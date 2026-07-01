// Server-side reference-pitch generation (Tier 3 karaoke target line).
//
// We can't read the YouTube iframe's audio, so to get a "what note SHOULD you
// hit" line we download the audio (yt-dlp, already used for search), decode it
// to mono PCM (ffmpeg), and run the SAME pitch detector (lib/pitch.ts) over the
// whole song to produce a compact contour. Streamed through pipes — nothing
// hits disk, so there's nothing to delete. Results are cached forever per video
// (SQLite), so a song is only ever analyzed once.
//
// Caveat: monophonic detection on a FULL mix is noisy on dense arrangements (it
// tracks the loudest thing, not always the vocal). Good on vocal-forward songs.

import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  contourFrame,
  contourFrameCount,
  medianSmoothContour,
  type ContourPoint,
} from "@/lib/pitch";
import { getCachedContour, putCachedContour } from "@/lib/db";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SAMPLE_RATE = 16000; // plenty for vocal pitch; keeps the PCM small
const FPS = 12; // contour frames per second (≈83ms hop)
const GEN_TIMEOUT_MS = 90_000; // pre-processing, not interactive — be generous
const FAIL_COOLDOWN_MS = 60_000; // after a failure, wait before retrying a video
// Optional yt-dlp --extractor-args. On datacenter/cloud IPs YouTube often bot-
// walls the default web client ("Sign in to confirm you're not a bot"), which
// breaks audio download even when search (metadata) still works. Setting e.g.
// YTDLP_EXTRACTOR_ARGS="youtube:player_client=android" usually gets around it.
// Empty by default = no behavior change.
const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || "";
// Optional proxy (e.g. a residential/mobile one) for yt-dlp. The durable fix for
// the datacenter bot-wall: route the download through an IP YouTube trusts, so
// it doesn't depend on constantly-rotating account cookies. Empty = direct.
const PROXY = process.env.YTDLP_PROXY || "";
// Cookies. `YTDLP_COOKIES` is the read-only Secret mount (a Netscape
// cookies.txt). yt-dlp ROTATES the session and rewrites the cookie file on every
// use — and expects that refreshed copy to be reused next time. So we keep a
// PERSISTENT writable copy on the /data PVC and point yt-dlp at THAT: the Secret
// seeds it once, then yt-dlp keeps it fresh, so the session survives (replaying
// the original stale cookies every run is what got us re-bot-walled in minutes).
// Generation is serialized (see generateContour) so only one process ever
// writes this file at a time.
const COOKIES = process.env.YTDLP_COOKIES || ""; // read-only Secret mount
const COOKIES_STORE = process.env.YTDLP_COOKIES_STORE || "/data/yt-cookies.txt";

function cookieArgs(): string[] {
  if (!COOKIES || !existsSync(COOKIES)) return [];
  try {
    // Seed the writable store from the Secret on first use, and RE-seed only
    // when the Secret's CONTENT changes (you re-exported + updated it). We key
    // off a content hash, not mtime — a Secret mount gets a fresh mtime on every
    // pod restart, which would otherwise clobber yt-dlp's rotated session with
    // the original (by-then stale) cookies on each deploy/cron restart.
    const secret = readFileSync(COOKIES);
    const hash = createHash("sha256").update(secret).digest("hex");
    const marker = COOKIES_STORE + ".seed";
    const seeded = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (!existsSync(COOKIES_STORE) || hash !== seeded) {
      writeFileSync(COOKIES_STORE, secret);
      writeFileSync(marker, hash);
    }
    return ["--cookies", COOKIES_STORE];
  } catch {
    return []; // couldn't set up the store → run without cookies (visible failure)
  }
}

// Videos currently being generated, so a second request doesn't start a dup run.
const inFlight = new Set<string>();
// Last failure per video (message + when), so the API can report WHY the target
// didn't generate, and so we back off instead of hammering a failing download.
const lastFail = new Map<string, { at: number; msg: string }>();

// Why a video has no contour yet, for the API + diagnostics. "generating" while
// in flight; otherwise the last error message (if any) so a failure is visible
// instead of looking like an endless "pending".
export function getContourError(videoId: string): string | undefined {
  if (inFlight.has(videoId)) return undefined; // still working — not an error
  return lastFail.get(videoId)?.msg;
}

function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

// Download bestaudio (yt-dlp) → decode to mono f32 PCM at SAMPLE_RATE (ffmpeg),
// piped together so nothing touches disk. Resolves the raw samples.
function decodePcm(videoId: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    // NOTE: no --quiet — we WANT yt-dlp's stderr so a download failure (the
    // usual root cause of a downstream "ffmpeg exited 1") is visible.
    const yt = spawn(YTDLP, [
      // Prefer audio-only, but fall back to the best combined stream if none is
      // offered (ffmpeg strips the audio out anyway) — avoids "Requested format
      // is not available" when a client only returns muxed formats.
      "-f",
      "bestaudio/best",
      "-o",
      "-",
      "--no-warnings",
      ...(EXTRACTOR_ARGS ? ["--extractor-args", EXTRACTOR_ARGS] : []),
      ...(PROXY ? ["--proxy", PROXY] : []),
      ...cookieArgs(),
      videoUrl(videoId),
    ]);
    const ff = spawn(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "f32le",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let bytesOut = 0;
    let ytErr = "";
    let ffErr = "";
    let ffDone = false;
    let ytDone = false;
    let ffCode: number | null = null;
    let ytCode: number | null = null;
    let settled = false;

    const finish = (err: Error | null, value?: Float32Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try {
          yt.kill("SIGKILL");
        } catch {}
        try {
          ff.kill("SIGKILL");
        } catch {}
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("reference: generation timed out")),
      GEN_TIMEOUT_MS
    );
    // The last non-empty line of a captured stderr — the useful part of a
    // yt-dlp/ffmpeg error (e.g. "Sign in to confirm you're not a bot").
    const tail = (s: string) =>
      s.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";

    const maybeSettle = () => {
      if (settled || !ffDone) return;
      if (ffCode === 0 && bytesOut >= 4) {
        const buf = Buffer.concat(chunks);
        // f32le bytes → Float32Array. Copy into a fresh, 4-aligned ArrayBuffer
        // so the view is valid regardless of Buffer.concat's alignment.
        const usable = buf.byteLength - (buf.byteLength % 4);
        const ab = new ArrayBuffer(usable);
        new Uint8Array(ab).set(buf.subarray(0, usable));
        finish(null, new Float32Array(ab));
        return;
      }
      // Failure. Wait for yt-dlp to finish too so we can blame the real culprit:
      // an ffmpeg error here is almost always downstream of yt-dlp yielding no
      // audio (bot-wall / 403 / unavailable), so surface yt-dlp's message.
      if (!ytDone) return;
      if (bytesOut < 4 || (ytCode !== null && ytCode !== 0)) {
        const why = tail(ytErr);
        finish(new Error(`reference: yt-dlp download failed${why ? ` — ${why}` : ""}`));
      } else {
        const why = tail(ffErr);
        finish(new Error(`reference: ffmpeg exited ${ffCode}${why ? ` — ${why}` : ""}`));
      }
    };

    yt.on("error", (e) =>
      finish(new Error(`reference: yt-dlp not runnable — ${e.message}`))
    );
    ff.on("error", (e) =>
      finish(new Error(`reference: ffmpeg not runnable — ${e.message}`))
    );
    yt.stderr.on("data", (d: Buffer) => {
      if (ytErr.length < 4000) ytErr += d.toString();
    });
    ff.stderr.on("data", (d: Buffer) => {
      if (ffErr.length < 4000) ffErr += d.toString();
    });
    // If ffmpeg exits first, yt-dlp's pipe write fails with EPIPE — ignore it.
    yt.stdout.on("error", () => {});
    ff.stdin.on("error", () => {});
    yt.stdout.pipe(ff.stdin);

    ff.stdout.on("data", (d: Buffer) => {
      chunks.push(d);
      bytesOut += d.length;
    });
    yt.on("close", (code) => {
      ytCode = code;
      ytDone = true;
      maybeSettle();
    });
    ff.on("close", (code) => {
      ffCode = code;
      ffDone = true;
      maybeSettle();
    });
  });
}

// Scan the PCM into a midi contour, yielding to the event loop periodically so a
// multi-second scan can't starve Socket.IO on the single-threaded server.
async function computeContour(pcm: Float32Array): Promise<number[]> {
  const count = contourFrameCount(pcm.length, SAMPLE_RATE, FPS);
  const points: ContourPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push(contourFrame(pcm, SAMPLE_RATE, FPS, i));
    if ((i & 63) === 63) await new Promise((r) => setImmediate(r));
  }
  return medianSmoothContour(points).map((p) => p.midi);
}

// Serialize generation: run one video at a time. Two reasons — (1) the shared
// rotating cookie store must not be written by two yt-dlp processes at once, and
// (2) it caps memory to a single decode+PCM in flight (the cluster is tight on
// RAM). Pre-warming several queued songs just processes them back-to-back.
let genChain: Promise<unknown> = Promise.resolve();

export function generateContour(
  videoId: string
): Promise<{ fps: number; midis: number[] }> {
  const run = genChain.then(async () => {
    const pcm = await decodePcm(videoId);
    const midis = await computeContour(pcm);
    return { fps: FPS, midis };
  });
  // Keep the chain going regardless of this run's outcome.
  genChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Fire-and-forget pre-warm: generate + cache a video's contour unless it's
// already cached or mid-generation. Safe to call on every queue add.
export function ensureContour(videoId: string): void {
  if (!videoId || inFlight.has(videoId)) return;
  if (getCachedContour(videoId)) return;
  // Back off after a recent failure so a polling client can't trigger a heavy
  // download attempt every few seconds while something is genuinely broken.
  const f = lastFail.get(videoId);
  if (f && Date.now() - f.at < FAIL_COOLDOWN_MS) return;
  lastFail.delete(videoId); // fresh attempt — clear the stale error
  inFlight.add(videoId);
  generateContour(videoId)
    .then(({ fps, midis }) => {
      putCachedContour(videoId, fps, midis);
      console.log(
        `> reference contour ready: ${videoId} (${midis.length} frames)`
      );
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      lastFail.set(videoId, { at: Date.now(), msg });
      console.warn(`> reference contour failed for ${videoId}: ${msg}`);
    })
    .finally(() => inFlight.delete(videoId));
}
