"use client";

// Host-side pitch ribbon. Listens for the singing remote's pitch samples and
// paints a scrolling, SingStar-style lane of the *singer's own* pitch over the
// video, plus a live tune score. There is no reference melody (we can't read the
// YouTube audio), so this scores closeness-to-the-nearest-note + steadiness
// rather than right-vs-wrong against a chart.

import { useEffect, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import {
  emptyScore,
  foldScoreVsRef,
  noteName,
  pitchMatchScore,
  rankScores,
  referenceMidiAt,
  tuneScore,
  type PitchSample,
  type ScoreState,
  type SingerScore,
} from "@/lib/pitch";

const WINDOW_MS = 6000; // seconds of history shown across the lane
const IDLE_HIDE_MS = 2500; // hide the ribbon this long after the last sample
const MIN_SPAN = 14; // keep the lane at least this many semitones tall
const HUD_INTERVAL_MS = 100; // throttle React HUD updates (canvas stays 60fps)

type Stamped = PitchSample & { t: number };

// Trace a rounded-rectangle path (no dependency on ctx.roundRect for older TVs).
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

type Props = {
  // Called once when the song ends (this component unmounts), with the final
  // per-singer ranking, so the host can show a score card. Omitted/empty when
  // nobody sang.
  onFinalize?: (results: SingerScore[]) => void;
  // The song's reference pitch line (Tier 3 target): one midi per frame
  // (-1 = unvoiced) at `referenceFps`. Drawn as a "target" lane, scrolled in
  // song-time via the live player position. Null = not ready / unavailable.
  referenceMidis?: number[] | null;
  referenceFps?: number;
  showTarget?: boolean; // room toggle: draw the target line or not (default on)
  songTimeSec?: number; // current playback position (host's authoritative time)
  playing?: boolean; // is the video actually playing right now
};

// The host remounts this per song (via React `key`), so all state — including
// the per-singer scores — resets naturally when the now-playing song changes.
export function PitchRibbon({
  onFinalize,
  referenceMidis,
  referenceFps = 12,
  showTarget = true,
  songTimeSec = 0,
  playing = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<Stamped[]>([]);
  const lastSampleAtRef = useRef(0);
  // Smoothed vertical range (MIDI) so the lane glides instead of snapping.
  const rangeRef = useRef({ lo: 55, hi: 72 });

  // Reference line + a song-time anchor, mirrored into refs so the []-deps draw
  // loop reads the latest without re-subscribing. `anchor` maps song-time onto
  // wall-clock: at wall time `anchor.wall`, the song was at `anchor.songTime`.
  const refMidisRef = useRef<number[] | null>(null);
  const refFpsRef = useRef(referenceFps);
  const showTargetRef = useRef(showTarget);
  // A STABLE vertical range derived once from the whole contour, so the axis
  // doesn't wobble as notes scroll in/out (the cause of the up/down drift).
  const contourRangeRef = useRef<{ lo: number; hi: number } | null>(null);
  const songAnchorRef = useRef({ songTime: 0, wall: 0 });
  const playingRef = useRef(false);
  useEffect(() => {
    showTargetRef.current = showTarget;
  }, [showTarget]);
  useEffect(() => {
    refMidisRef.current = referenceMidis ?? null;
    refFpsRef.current = referenceFps || 12;
    // Lock the vertical axis to the song's full pitch span (padded) so it holds
    // still for the whole song instead of chasing the moving window.
    if (referenceMidis && referenceMidis.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const m of referenceMidis) {
        if (m >= 0) {
          if (m < lo) lo = m;
          if (m > hi) hi = m;
        }
      }
      if (lo <= hi) {
        const mid = (lo + hi) / 2;
        const span = Math.max(MIN_SPAN, hi - lo + 4);
        contourRangeRef.current = { lo: mid - span / 2, hi: mid + span / 2 };
      } else {
        contourRangeRef.current = null;
      }
    } else {
      contourRangeRef.current = null;
    }
  }, [referenceMidis, referenceFps]);
  useEffect(() => {
    songAnchorRef.current = { songTime: songTimeSec, wall: performance.now() };
    playingRef.current = playing;
  }, [songTimeSec, playing]);

  const [visible, setVisible] = useState(false);
  const [note, setNote] = useState("");
  // One running score per singer, accumulated every sample. The score itself is
  // shown ONLY on the end-of-song card (no live meter) — evaluated over the whole
  // take — but we still track the dominant singer live to label the note readout.
  const scoresRef = useRef<Map<string, ScoreState>>(new Map());
  const lastHudRef = useRef(0);
  // The "featured" singer whose big score is shown. When several people sing at
  // once their samples interleave, so we pick the DOMINANT singer over a short
  // window (with hysteresis) instead of flipping to whoever sent the last sample.
  const featuredRef = useRef("");
  const lastMidiRef = useRef<Map<string, number>>(new Map());

  // Keep the latest onFinalize without re-subscribing — the finalize fires from
  // the [] effect's unmount cleanup, which would otherwise capture a stale prop.
  const finalizeRef = useRef(onFinalize);
  useEffect(() => {
    finalizeRef.current = onFinalize;
  });

  // Collect incoming pitch samples from the singing remote(s), folding each into
  // its singer's running score. Throttle the React state updates; the canvas
  // reads the refs directly so the ribbon itself stays smooth.
  useEffect(() => {
    const socket = getSocket();
    const onSample = (s: PitchSample) => {
      const now = performance.now();
      lastSampleAtRef.current = now;
      samplesRef.current.push({ ...s, t: now });

      const singer = s.singer || "Guest";
      lastMidiRef.current.set(singer, s.midi);
      const prev = scoresRef.current.get(singer) ?? emptyScore;
      // Score against the song's melody at the song-time this sample is drawn
      // at — the same note the ribbon shows under the singer's dot, so the score
      // and the colors agree. With no contour yet, or while paused, targetMidi
      // is -1 and foldScoreVsRef falls back to self-tune.
      const a = songAnchorRef.current;
      const songT = a.songTime + (now - a.wall) / 1000;
      const targetMidi = playingRef.current
        ? referenceMidiAt(refMidisRef.current, refFpsRef.current, songT)
        : -1;
      scoresRef.current.set(singer, foldScoreVsRef(prev, s, targetMidi));

      if (now - lastHudRef.current >= HUD_INTERVAL_MS) {
        lastHudRef.current = now;
        // Dominant singer over the last ~1.5s (voiced samples), so the big score
        // sticks with whoever's actually carrying the song rather than flickering
        // between everyone. Only switch when the current one goes quiet or another
        // clearly takes over (hysteresis), so a duet doesn't strobe.
        const cutoff = now - 1500;
        const counts = new Map<string, number>();
        const samples = samplesRef.current;
        for (let k = samples.length - 1; k >= 0 && samples[k].t >= cutoff; k--) {
          if (samples[k].midi > 0) {
            const sg = samples[k].singer || "Guest";
            counts.set(sg, (counts.get(sg) ?? 0) + 1);
          }
        }
        let featured = featuredRef.current;
        const curCount = counts.get(featured) ?? 0;
        let bestSinger = featured;
        let bestCount = curCount;
        for (const [sg, c] of counts) {
          if (c > bestCount) {
            bestCount = c;
            bestSinger = sg;
          }
        }
        if (curCount === 0 || bestCount >= curCount * 1.4) featured = bestSinger;
        featuredRef.current = featured || singer;
        const fm = lastMidiRef.current.get(featuredRef.current) ?? -1;
        setNote(fm > 0 ? noteName(fm) : "");
      }
    };
    socket.on("pitch:sample", onSample);
    return () => {
      socket.off("pitch:sample", onSample);
      // Song ended → hand the final ranking up for the score card. We WANT the
      // latest accumulated scores here (the ref is a data store, not a DOM
      // node), so reading scoresRef.current at cleanup time is intentional.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const results = rankScores(scoresRef.current);
      if (results.length) finalizeRef.current?.(results);
    };
  }, []);

  // Render loop: scroll + paint the lane, and drive show/hide.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();

      // Current song-time, interpolated from the last reported position.
      const anchor = songAnchorRef.current;
      const songTimeNow = playingRef.current
        ? anchor.songTime + (now - anchor.wall) / 1000
        : anchor.songTime;
      const ref = refMidisRef.current;
      const fps = refFpsRef.current;
      const haveRef =
        !!ref && ref.length > 0 && playingRef.current && showTargetRef.current;

      // Stay visible while someone's singing OR a reference line is scrolling.
      const live =
        now - lastSampleAtRef.current < IDLE_HIDE_MS || haveRef;
      setVisible((v) => (v !== live ? live : v));

      const canvas = canvasRef.current;
      if (!canvas || !live) return;

      // "Now" (the moment playing on screen) sits at the CENTER: the singer's
      // trace trails off to the left (the past), and upcoming target notes
      // approach from the right (the future). So each half spans HALF_MS.
      const HALF_MS = WINDOW_MS / 2;

      // Drop samples that have scrolled off the left edge (older than HALF_MS).
      const cutoff = now - HALF_MS;
      const samples = samplesRef.current;
      while (samples.length && samples[0].t < cutoff) samples.shift();

      // Size the backing store to the element (handles resize + DPR).
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // now → center (0.5·w); past → left, future → right.
      const xOf = (t: number) => ((t - now) / WINDOW_MS + 0.5) * w;
      // Map a reference frame index → its wall-clock time (so it shares xOf).
      const wallOfFrame = (i: number) =>
        anchor.wall + (i / fps - anchor.songTime) * 1000;
      // Reference frames visible across the full [past, future] window.
      const refStart = haveRef
        ? Math.max(0, Math.floor((songTimeNow - HALF_MS / 1000) * fps))
        : 0;
      const refEnd = haveRef
        ? Math.min(ref!.length - 1, Math.ceil((songTimeNow + HALF_MS / 1000) * fps))
        : -1;

      // Vertical axis. With a target line, lock to the song's full pitch span so
      // the axis holds still (no up/down drift). Otherwise auto-range to the
      // singer's recent pitch.
      let target: { lo: number; hi: number } | null = null;
      if (haveRef && contourRangeRef.current) {
        target = contourRangeRef.current;
      } else {
        let lo = Infinity;
        let hi = -Infinity;
        for (const s of samples) {
          if (s.midi > 0) {
            if (s.midi < lo) lo = s.midi;
            if (s.midi > hi) hi = s.midi;
          }
        }
        if (lo <= hi) {
          const mid = (lo + hi) / 2;
          const span = Math.max(MIN_SPAN, hi - lo + 6);
          target = { lo: mid - span / 2, hi: mid + span / 2 };
        }
      }
      if (target) {
        const r = rangeRef.current;
        r.lo += (target.lo - r.lo) * 0.08;
        r.hi += (target.hi - r.hi) * 0.08;
      }
      const { lo, hi } = rangeRef.current;
      const yOf = (midi: number) => h - ((midi - lo) / (hi - lo)) * h;

      // Semitone gridlines.
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
        const y = yOf(m);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Note "block" height, tied to the semitone spacing so a block sits on its
      // own row. The singer's bar uses the same thickness so it fills a block.
      const semiPx = h / (hi - lo);
      const noteH = Math.max(10, Math.min(26, semiPx * 0.82));

      // ---- Target notes: hollow rounded blocks (SingStar style) ----
      // Group visible reference frames into notes (runs of consecutive frames at
      // the same semitone) and draw each as a hollow rounded bar. The singer's
      // voice fills them pink below when on-pitch.
      if (haveRef) {
        const halfFrameMs = 500 / fps; // half a frame, so adjacent blocks touch
        for (let i = refStart; i <= refEnd; ) {
          if (ref![i] < 0) {
            i++;
            continue;
          }
          const sm = Math.round(ref![i]);
          let j = i;
          while (
            j + 1 <= refEnd &&
            ref![j + 1] >= 0 &&
            Math.round(ref![j + 1]) === sm
          ) {
            j++;
          }
          const x0 = xOf(wallOfFrame(i) - halfFrameMs);
          const x1 = xOf(wallOfFrame(j) + halfFrameMs);
          roundedRectPath(ctx, x0, yOf(sm) - noteH / 2, Math.max(noteH, x1 - x0), noteH, noteH / 2);
          ctx.fillStyle = "rgba(255,255,255,0.10)";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.stroke();
          i = j + 1;
        }
      }

      // ---- Singer's voice: fills the target block pink when matched ----
      // A thick rounded bar at the sung pitch. With a contour playing we fold the
      // sung note into the target's octave, so hitting the right pitch class lands
      // the bar INSIDE the block (filling it); color runs violet→pink by how on-note.
      ctx.lineCap = "round";
      ctx.lineWidth = noteH;
      let prevX = 0;
      let prevY = 0;
      let prevT = 0;
      let prevOk = false;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s.midi <= 0) {
          prevOk = false;
          continue;
        }
        let quality: number;
        let disp = s.midi;
        if (ref && ref.length && playingRef.current) {
          const sSongT = anchor.songTime + (s.t - anchor.wall) / 1000;
          const tgt = referenceMidiAt(ref, fps, sSongT);
          if (tgt >= 0) {
            disp = s.midi - 12 * Math.round((s.midi - tgt) / 12); // fold to target octave
            quality = pitchMatchScore(s.midi, tgt);
          } else {
            quality = tuneScore(s.midi);
          }
        } else {
          quality = tuneScore(s.midi);
        }
        const x = xOf(s.t);
        const y = yOf(disp);
        // On-brand ramp matching the app's fuchsia→pink accent: deep violet
        // (hue 280) when off-pitch → bright pink (hue 328) when on-pitch, getting
        // more saturated and lighter as it locks on.
        ctx.strokeStyle = `hsl(${280 + quality * 48}, ${72 + quality * 20}%, ${52 + quality * 16}%)`;
        if (prevOk && s.t - prevT < 200 && Math.abs(y - prevY) < noteH * 2) {
          ctx.beginPath();
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(x, y);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, noteH / 2, 0, Math.PI * 2);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
        }
        prevX = x;
        prevY = y;
        prevT = s.t;
        prevOk = true;
      }

      // "Now" marker down the CENTER — the note playing on screen right now, and
      // where the singer's live pitch is drawn. Upcoming target notes scroll
      // toward it from the right.
      const mid = w / 2;
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mid, 0);
      ctx.lineTo(mid, h);
      ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 transition-opacity duration-500 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="relative mx-auto h-40 max-w-5xl bg-gradient-to-t from-black/70 to-transparent">
        <canvas ref={canvasRef} className="h-full w-full" />
        {/* No live score — the number is shown only on the end-of-song card, so
            it reflects the whole take. What stays on screen is the ribbon itself
            plus a legend for reading the trace colors. */}
        <div className="absolute left-4 top-3 flex items-start gap-3">
          <div className="flex flex-col gap-1 rounded-xl bg-black/50 px-3 py-1.5 text-[10px] font-medium text-white/70 backdrop-blur">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[hsl(328,92%,68%)]" /> On
              pitch
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[hsl(280,72%,52%)]" /> Off
              pitch
            </span>
            {showTarget && referenceMidis && referenceMidis.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm border border-white/60" />{" "}
                Target note
              </span>
            )}
          </div>
        </div>
        {note && (
          <div className="absolute right-4 top-3 rounded-xl bg-black/50 px-3 py-1.5 text-2xl font-black tabular-nums text-white backdrop-blur">
            {note}
          </div>
        )}
      </div>
    </div>
  );
}
