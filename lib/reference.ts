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
    const yt = spawn(YTDLP, [
      "-f",
      "bestaudio",
      "-o",
      "-",
      "--no-warnings",
      "--quiet",
      ...(EXTRACTOR_ARGS ? ["--extractor-args", EXTRACTOR_ARGS] : []),
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

    yt.on("error", (e) => finish(e));
    ff.on("error", (e) => finish(e));
    // If ffmpeg exits first, yt-dlp's pipe write fails with EPIPE — ignore it.
    yt.stdout.on("error", () => {});
    ff.stdin.on("error", () => {});
    yt.stdout.pipe(ff.stdin);

    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`reference: ffmpeg exited ${code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      // f32le bytes → Float32Array. Copy into a fresh, 4-aligned ArrayBuffer so
      // the typed-array view is valid regardless of Buffer.concat's alignment.
      const usable = buf.byteLength - (buf.byteLength % 4);
      if (usable < 4) {
        finish(new Error("reference: empty/too-short audio"));
        return;
      }
      const ab = new ArrayBuffer(usable);
      new Uint8Array(ab).set(buf.subarray(0, usable));
      finish(null, new Float32Array(ab));
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

export async function generateContour(
  videoId: string
): Promise<{ fps: number; midis: number[] }> {
  const pcm = await decodePcm(videoId);
  const midis = await computeContour(pcm);
  return { fps: FPS, midis };
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
