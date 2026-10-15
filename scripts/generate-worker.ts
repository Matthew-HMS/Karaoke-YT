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
// Pacing, to avoid YouTube flagging a burst of downloads from one IP. Process at
// most MAX_PER_TICK videos per poll, with a GEN_GAP_MS (+ up to GEN_GAP_JITTER_MS
// random) pause between each. Tune via env if your IP is stricter/looser.
const MAX_PER_TICK = Number(process.env.GEN_MAX_PER_TICK || 3);
const GEN_GAP_MS = Number(process.env.GEN_GAP_MS || 8_000);
const GEN_GAP_JITTER_MS = Number(process.env.GEN_GAP_JITTER_MS || 7_000);
// Give up on a video after this many failures IN THIS SESSION, so a dead or
// unfetchable-here video at the head of the pending list doesn't get retried
// forever and starve the live songs behind it. (Server still lists it; we just
// stop attempting it until the worker restarts.)
const MAX_FAILS = Number(process.env.GEN_MAX_FAILS || 3);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SAMPLE_RATE = 16_000; // must match lib/reference.ts
const FPS = 12; // must match lib/reference.ts
const DECODE_TIMEOUT_MS = 120_000;
// Same yt-dlp knobs as lib/reference.ts, for when this worker's IP gets
// bot-walled too (HTTP 403 on audio download). `YTDLP_EXTRACTOR_ARGS` is the
// usual fix — e.g. "youtube:player_client=android" downloads where the default
// web client 403s. `YTDLP_PROXY`/`YTDLP_COOKIES` are the heavier fallbacks.
const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || "";
const PROXY = process.env.YTDLP_PROXY || "";
const COOKIES = process.env.YTDLP_COOKIES || "";

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
    const yt = spawn(YTDLP, [
      "-f", "bestaudio/best", "-o", "-", "--no-warnings",
      ...(EXTRACTOR_ARGS ? ["--extractor-args", EXTRACTOR_ARGS] : []),
      ...(PROXY ? ["--proxy", PROXY] : []),
      ...(COOKIES ? ["--cookies", COOKIES] : []),
      url,
    ]);
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

// Videos that failed MAX_FAILS times this session — skipped so they don't block
// the queue. Resets on restart (so genuinely-transient ones get another chance).
const fails = new Map<string, number>();

// Tell the server to DROP a video we've given up on, so it's removed from the
// pending list for good (not just skipped this session). Best-effort.
async function dropPending(videoId: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/reference/pending`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
  } catch {
    // network blip — the in-memory skip still keeps it out of this session
  }
}

async function tick(): Promise<void> {
  const res = await fetch(`${BASE}/api/reference/pending`, { headers: auth });
  if (!res.ok) throw new Error(`pending HTTP ${res.status}`);
  const { videoIds } = (await res.json()) as { videoIds: string[] };
  // Drop the ones we've given up on, THEN take a small paced batch. Downloading
  // the whole backlog back-to-back from one IP is what makes YouTube flag it
  // (→ "not available" / "sign in"); a small batch + a randomized gap looks far
  // less bot-like, so more contours actually land.
  const live = videoIds.filter((id) => (fails.get(id) ?? 0) < MAX_FAILS);
  const skipped = videoIds.length - live.length;
  const batch = live.slice(0, MAX_PER_TICK);
  for (let i = 0; i < batch.length; i++) {
    const id = batch[i];
    try {
      await generateAndSend(id);
      fails.delete(id); // success → forget any earlier failures
    } catch (e) {
      const n = (fails.get(id) ?? 0) + 1;
      fails.set(id, n);
      let note = "";
      if (n >= MAX_FAILS) {
        await dropPending(id); // purge it server-side so it won't come back
        note = ` — giving up (failed ${n}×), dropped from pending`;
      }
      console.warn(`✗ ${id} — ${e instanceof Error ? e.message : String(e)}${note}`);
    }
    // Jittered gap before the next download (not after the last one).
    if (i < batch.length - 1) {
      await sleep(GEN_GAP_MS + Math.floor(Math.random() * GEN_GAP_JITTER_MS));
    }
  }
  if (batch.length === 0 && skipped > 0) {
    // Nothing left to try — everything pending has been given up on this session.
    console.log(`(idle: ${skipped} pending video(s) skipped after repeated failures)`);
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
