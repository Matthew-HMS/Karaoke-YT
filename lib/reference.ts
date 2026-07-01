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
import { existsSync } from "fs";
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
// Optional path to a Netscape cookies.txt (mounted from a k8s Secret). This is
// the reliable fix when the IP is fully bot-walled and no player_client slips
// past unauthenticated — yt-dlp then downloads as a signed-in session. We only
// pass it when the file actually EXISTS, so the app still runs (falling back to
// no-cookies) if the Secret isn't mounted yet — no startup dependency on it.
const COOKIES = process.env.YTDLP_COOKIES || "";
const cookieArgs = (): string[] =>
  COOKIES && existsSync(COOKIES) ? ["--cookies", COOKIES] : [];

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
      "-f",
      "bestaudio",
      "-o",
      "-",
      "--no-warnings",
      ...(EXTRACTOR_ARGS ? ["--extractor-args", EXTRACTOR_ARGS] : []),
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
