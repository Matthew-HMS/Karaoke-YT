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
  // Active singer = whoever sent the most recent sample (the one being drawn).
  const [activeSinger, setActiveSinger] = useState("");
  // Live leaderboard, recomputed (throttled) as samples arrive.
  const [board, setBoard] = useState<SingerScore[]>([]);
  // One running score per singer, accumulated every sample (the source of truth
  // for both the live board and the song-end card).
  const scoresRef = useRef<Map<string, ScoreState>>(new Map());
  const lastHudRef = useRef(0);

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
        setActiveSinger(singer);
        setNote(s.midi > 0 ? noteName(s.midi) : "");
        setBoard(rankScores(scoresRef.current));
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

      // Reference "target" lane — the song's own pitch line, drawn behind the
      // singer's trace in a cool tone so on-pitch singing sits right on top.
      // Connect consecutive voiced frames; isolated voiced frames (next to a
      // gap) still get a dot, so a sparse contour doesn't vanish.
      if (haveRef) {
        ctx.lineCap = "round";
        ctx.lineWidth = 7;
        ctx.strokeStyle = "rgba(130,170,255,0.5)";
        ctx.fillStyle = "rgba(130,170,255,0.5)";
        for (let i = refStart; i <= refEnd; i++) {
          if (ref![i] < 0) continue;
          const x = xOf(wallOfFrame(i));
          const y = yOf(ref![i]);
          if (i > refStart && ref![i - 1] >= 0) {
            ctx.beginPath();
            ctx.moveTo(xOf(wallOfFrame(i - 1)), yOf(ref![i - 1]));
            ctx.lineTo(x, y);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // The pitch trace: rounded segments colored green→red by in-tune-ness.
      ctx.lineCap = "round";
      ctx.lineWidth = 8;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s.midi <= 0) continue;
        const x = xOf(s.t);
        const y = yOf(s.midi);
        // Color by quality: against the melody (right note, octave-folded) when
        // a contour is playing, else self-tune (in-tune-ness). Look up the
        // target at the SAME song-time the dot is drawn at — the note shown
        // right under it — so the color matches the blue line you see.
        let quality: number;
        if (ref && ref.length && playingRef.current) {
          const sSongT = anchor.songTime + (s.t - anchor.wall) / 1000;
          const tgt = referenceMidiAt(ref, fps, sSongT);
          quality = tgt >= 0 ? pitchMatchScore(s.midi, tgt) : tuneScore(s.midi);
        } else {
          quality = tuneScore(s.midi);
        }
        const hue = quality * 120; // 0 red .. 120 green
        ctx.strokeStyle = `hsla(${hue}, 90%, 55%, ${0.35 + 0.65 * s.clarity})`;
        const prev = samples[i - 1];
        if (prev && prev.midi > 0 && s.t - prev.t < 200) {
          ctx.beginPath();
          ctx.moveTo(xOf(prev.t), yOf(prev.midi));
          ctx.lineTo(x, y);
          ctx.stroke();
        } else {
          // Lone point (after a gap): a dot so it's still visible.
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
        }
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
        {/* Active singer's score + the live leaderboard. */}
        <div className="absolute left-4 top-3 flex items-end gap-3">
          <div className="rounded-xl bg-black/50 px-3 py-1.5 backdrop-blur">
            <div className="max-w-[160px] truncate text-[10px] font-medium uppercase tracking-wide text-white/50">
              {activeSinger ? `🎤 ${activeSinger}` : "Score"}
            </div>
            <div className="bg-gradient-to-r from-fuchsia-400 to-pink-400 bg-clip-text text-3xl font-black leading-none tabular-nums text-transparent">
              {board.find((b) => b.singer === activeSinger)?.score ?? 0}
            </div>
            {/* What the number means: matching the melody vs. just steady/in-tune. */}
            <div className="mt-0.5 text-[9px] font-medium uppercase tracking-wide text-white/40">
              {referenceMidis && referenceMidis.length > 0
                ? "🎯 melody match"
                : "🎵 in tune"}
            </div>
          </div>
          {/* Leaderboard — only when more than one person has sung. */}
          {board.length > 1 && (
            <div className="rounded-xl bg-black/50 px-3 py-1.5 backdrop-blur">
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-white/50">
                Leaderboard
              </div>
              <ol className="space-y-0.5">
                {board.slice(0, 4).map((b, i) => (
                  <li
                    key={b.singer}
                    className={`flex items-center justify-between gap-3 text-xs tabular-nums ${
                      b.singer === activeSinger ? "text-white" : "text-white/60"
                    }`}
                  >
                    <span className="truncate">
                      {["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`}{" "}
                      <span className="max-w-[110px] truncate">{b.singer}</span>
                    </span>
                    <span className="font-bold">{b.score}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {/* Legend: what the trace colors mean. */}
          <div className="flex flex-col gap-1 rounded-xl bg-black/50 px-3 py-1.5 text-[10px] font-medium text-white/70 backdrop-blur">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[hsl(120,90%,55%)]" /> On
              pitch
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[hsl(0,90%,55%)]" /> Off
              pitch
            </span>
            {showTarget && referenceMidis && referenceMidis.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[rgb(130,170,255)]" />{" "}
                Target
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
