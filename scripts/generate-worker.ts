// Off-cluster reference-contour worker.
//
// The production cluster runs on a datacenter IP that YouTube bot-walls, so it
// can't download song audio for the karaoke target-pitch line. This worker runs
// somewhere with a NON-walled IP (a home / school / uni box), pulls the list of
// videos that need a contour, generates each one locally with yt-dlp + ffmpeg
// (the SAME pitch math as the app, from lib/pitch.ts), and POSTs the result back.
//
// Run it from the repo root (so the @/lib import resolves), e.g.:
//   REFERENCE_BASE_URL="https://sho-karaoke.duckdns.org" \
//   REFERENCE_INGEST_TOKEN="<same token as the cluster Secret>" \
//   npx tsx scripts/generate-worker.ts
//
// Requires `yt-dlp` and `ffmpeg` on PATH (or set YTDLP_PATH / FFMPEG_PATH).
// Leave it running (systemd / tmux / pm2) so queued songs get contours promptly.

import { spawn } from "child_process";
import {
  contourFrame,
  contourFrameCount,
  medianSmoothContour,
  type ContourPoint,
} from "@/lib/pitch";

const BASE = (process.env.REFERENCE_BASE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.REFERENCE_INGEST_TOKEN || "";
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SAMPLE_RATE = 16_000; // must match lib/reference.ts
const FPS = 12; // must match lib/reference.ts
const DECODE_TIMEOUT_MS = 120_000;

if (!BASE || !TOKEN) {
  console.error(
    "Set REFERENCE_BASE_URL and REFERENCE_INGEST_TOKEN (see the header comment)."
  );
  process.exit(1);
}

const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// yt-dlp bestaudio → ffmpeg mono f32 PCM @ SAMPLE_RATE, piped (nothing on disk).
function decodePcm(videoId: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const yt = spawn(YTDLP, ["-f", "bestaudio/best", "-o", "-", "--no-warnings", url]);
    const ff = spawn(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let ytErr = "";
    let done = false;
    const finish = (err: Error | null, val?: Float32Array) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        try { yt.kill("SIGKILL"); } catch {}
        try { ff.kill("SIGKILL"); } catch {}
        reject(err);
      } else {
        resolve(val!);
      }
    };
    const timer = setTimeout(() => finish(new Error("decode timed out")), DECODE_TIMEOUT_MS);

    yt.on("error", finish);
    ff.on("error", finish);
    yt.stderr.on("data", (d: Buffer) => { if (ytErr.length < 2000) ytErr += d.toString(); });
    yt.stdout.on("error", () => {});
    ff.stdin.on("error", () => {});
    yt.stdout.pipe(ff.stdin);

    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.on("close", (code) => {
      if (code !== 0) {
        const why = ytErr.trim().split("\n").pop() || "";
        finish(new Error(`ffmpeg exited ${code}${why ? ` / yt-dlp: ${why}` : ""}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const usable = buf.byteLength - (buf.byteLength % 4);
      if (usable < 4) return finish(new Error("empty/too-short audio"));
      const ab = new ArrayBuffer(usable);
      new Uint8Array(ab).set(buf.subarray(0, usable));
      finish(null, new Float32Array(ab));
    });
  });
}

async function computeContour(pcm: Float32Array): Promise<number[]> {
  const count = contourFrameCount(pcm.length, SAMPLE_RATE, FPS);
  const points: ContourPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push(contourFrame(pcm, SAMPLE_RATE, FPS, i));
    if ((i & 63) === 63) await new Promise((r) => setImmediate(r));
  }
  return medianSmoothContour(points).map((p) => p.midi);
}

async function generateAndSend(videoId: string): Promise<void> {
  const t0 = Date.now();
  const pcm = await decodePcm(videoId);
  const midis = await computeContour(pcm);
  const res = await fetch(`${BASE}/api/reference`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ videoId, fps: FPS, midis }),
  });
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
  console.log(`✓ ${videoId} — ${midis.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function tick(): Promise<void> {
  const res = await fetch(`${BASE}/api/reference/pending`, { headers: auth });
  if (!res.ok) throw new Error(`pending HTTP ${res.status}`);
  const { videoIds } = (await res.json()) as { videoIds: string[] };
  for (const id of videoIds) {
    try {
      await generateAndSend(id);
    } catch (e) {
      console.warn(`✗ ${id} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`reference worker → ${BASE} (poll ${POLL_MS}ms)`);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.warn(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(POLL_MS);
  }
}

void main();
