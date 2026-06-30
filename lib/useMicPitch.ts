"use client";

// Mic pitch capture as a hook, so it can live at the page level (always mounted)
// and keep running independently of whatever UI shows the Sing button. That's
// what lets the singer close the controls panel mid-song without dropping the
// mic — the capture state isn't tied to the panel's mount.
//
// The phone listens to its own microphone, runs autocorrelation pitch detection
// in the browser, and streams the detected note via `onSample`. The host never
// gets audio — only the already-extracted pitch numbers travel.

import { useCallback, useEffect, useRef, useState } from "react";
import { detectPitch, freqToMidi, noteName, type PitchSample } from "@/lib/pitch";

const FFT_SIZE = 2048;
const SEND_INTERVAL_MS = 50; // ~20 samples/sec

export type MicPitch = {
  active: boolean;
  note: string; // current note name (e.g. "A4"), "" when unvoiced/idle
  level: number; // 0..1 mic level for a live meter
  error: string | null;
  start: () => void;
  stop: () => void;
};

export function useMicPitch(opts: {
  singer: string;
  onSample: (sample: PitchSample) => void;
}): MicPitch {
  const { singer, onSample } = opts;
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [level, setLevel] = useState(0);

  // Audio graph + loop handles, torn down on stop/unmount.
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest callback/singer without re-subscribing the running interval. Kept
  // fresh in an effect (not during render) so the capture loop always emits
  // through the current values.
  const cb = useRef({ onSample, singer });
  useEffect(() => {
    cb.current = { onSample, singer };
  });

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    setActive(false);
    setNote("");
    setLevel(0);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      // echoCancellation/noiseSuppression help strip the room speakers (the
      // backing track) back out of the mic so we track the *voice*, not the song.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      ctxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      setActive(true);
      timerRef.current = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);

        // MPM gives a real periodicity confidence — use it as the sample
        // clarity (scoring weight + ribbon alpha). The level meter wants
        // loudness instead, so derive that separately from RMS.
        const { hz, clarity } = detectPitch(buf, ctx.sampleRate);
        const midi = hz > 0 ? freqToMidi(hz) : -1;

        cb.current.onSample({ singer: cb.current.singer, midi, clarity });

        let rms = 0;
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
        setLevel(Math.min(1, rms * 8)); // loudness for the live meter

        setNote(midi > 0 ? noteName(midi) : "");
      }, SEND_INTERVAL_MS);
    } catch {
      setError("Mic access denied");
      stop();
    }
  }, [stop]);

  // Release the mic when the page using the hook unmounts.
  useEffect(() => stop, [stop]);

  return { active, note, level, error, start, stop };
}
