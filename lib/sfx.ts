"use client";

// Built-in party sound effects, synthesized in-browser with the Web Audio API
// (no audio files needed). Played on the host (TV) when a remote triggers one.

import { SfxName } from "./types";

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    ctx = new Ctor();
  }
  // Browsers start the context suspended until a user gesture; resume best-effort.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function noiseBuffer(ac: AudioContext, seconds: number): AudioBuffer {
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function airhorn(ac: AudioContext) {
  const t = ac.currentTime;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2200;
  lp.connect(ac.destination);

  const honk = (start: number, dur: number) => {
    const g = ac.createGain();
    g.connect(lp);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.4, start + 0.02);
    g.gain.setValueAtTime(0.4, start + dur - 0.06);
    g.gain.linearRampToValueAtTime(0, start + dur);
    [0, 7, 12].forEach((semi) => {
      const o = ac.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = 220 * Math.pow(2, semi / 12);
      o.connect(g);
      o.start(start);
      o.stop(start + dur);
    });
  };
  honk(t, 0.45);
  honk(t + 0.55, 0.9);
}

// A cheering finger-whistle: a near-pure tone that swoops up then down, with
// vibrato. Mixed into the applause for a "crowd going wild" feel.
function whistle(ac: AudioContext, start: number, master: AudioNode) {
  const o = ac.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(1600, start);
  o.frequency.exponentialRampToValueAtTime(2600, start + 0.18); // swoop up
  o.frequency.setValueAtTime(2600, start + 0.3);
  o.frequency.exponentialRampToValueAtTime(1900, start + 0.55); // swoop down

  // Vibrato.
  const lfo = ac.createOscillator();
  lfo.frequency.value = 6;
  const lfoGain = ac.createGain();
  lfoGain.gain.value = 40;
  lfo.connect(lfoGain);
  lfoGain.connect(o.frequency);

  const g = ac.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(0.5, start + 0.05);
  g.gain.setValueAtTime(0.5, start + 0.5);
  g.gain.linearRampToValueAtTime(0, start + 0.62);
  o.connect(g);
  g.connect(master);
  o.start(start);
  o.stop(start + 0.64);
  lfo.start(start);
  lfo.stop(start + 0.64);
}

function applause(ac: AudioContext) {
  const t0 = ac.currentTime;
  const dur = 2.6;
  const master = ac.createGain();
  master.connect(ac.destination);

  // A single hand clap: a very short, sharp burst of band-passed noise. Many of
  // these overlapping (with a density swell) read as a crowd clapping — far more
  // convincing than one long noise swell, which just sounds like rain.
  const clap = (start: number, amp: number, freq: number) => {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac, 0.03);
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = 1.4;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(amp, start + 0.002); // sharp attack
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.05); // quick decay
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(start);
    src.stop(start + 0.06);
  };

  const N = 85;
  for (let i = 0; i < N; i++) {
    const pos = Math.random();
    const start = t0 + 0.04 + pos * (dur - 0.1);
    const env = pos < 0.2 ? pos / 0.2 : pos > 0.7 ? (1 - pos) / 0.3 : 1;
    const amp = (0.05 + Math.random() * 0.09) * (0.4 + 0.6 * env);
    clap(start, amp, 1000 + Math.random() * 1500);
  }
}

// Standalone "someone whistling" cheer — its own reaction (two finger-whistles).
function cheerWhistle(ac: AudioContext) {
  const master = ac.createGain();
  master.connect(ac.destination);
  whistle(ac, ac.currentTime, master);
  whistle(ac, ac.currentTime + 0.55, master);
}

function drumroll(ac: AudioContext) {
  const t = ac.currentTime;
  const master = ac.createGain();
  master.connect(ac.destination);

  const hit = (start: number, amp: number) => {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac, 0.06);
    const hp = ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const g = ac.createGain();
    g.gain.setValueAtTime(amp, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.06);
    src.connect(hp);
    hp.connect(g);
    g.connect(master);
    src.start(start);
    src.stop(start + 0.06);
  };

  let time = t;
  let interval = 0.07;
  for (let i = 0; i < 20; i++) {
    hit(time, 0.22);
    time += interval;
    interval *= 0.96; // accelerate
  }
  // Crash cymbal at the end.
  const crash = time + 0.05;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, 1.0);
  const hp = ac.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 4000;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.5, crash);
  g.gain.exponentialRampToValueAtTime(0.001, crash + 1.0);
  src.connect(hp);
  hp.connect(g);
  g.connect(master);
  src.start(crash);
  src.stop(crash + 1.0);
}

function tada(ac: AudioContext) {
  const t = ac.currentTime;
  const master = ac.createGain();
  master.connect(ac.destination);
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((f, i) => {
    const start = t + i * 0.12;
    const last = i === notes.length - 1;
    const dur = last ? 0.8 : 0.18;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.32, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    g.connect(master);
    const o = ac.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const o2 = ac.createOscillator();
    o2.type = "sawtooth";
    o2.frequency.value = f;
    o2.detune.value = 7;
    o.connect(g);
    o2.connect(g);
    o.start(start);
    o.stop(start + dur);
    o2.start(start);
    o2.stop(start + dur);
  });
}

function sadtrombone(ac: AudioContext) {
  const master = ac.createGain();
  master.connect(ac.destination);
  const notes = [233.08, 207.65, 185.0, 164.81]; // Bb3 Ab3 Gb3 E3, descending
  let start = ac.currentTime;
  notes.forEach((f, i) => {
    const dur = i === notes.length - 1 ? 0.7 : 0.32;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.4, start + 0.04);
    g.gain.setValueAtTime(0.4, start + dur - 0.06);
    g.gain.linearRampToValueAtTime(0, start + dur);
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const o = ac.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f * 1.06, start);
    o.frequency.linearRampToValueAtTime(f, start + 0.12); // trombone-y slide
    o.connect(lp);
    lp.connect(g);
    g.connect(master);
    o.start(start);
    o.stop(start + dur);
    start += dur + 0.02;
  });
}

const PLAYERS: Record<SfxName, (ac: AudioContext) => void> = {
  airhorn,
  applause,
  whistle: cheerWhistle,
  drumroll,
  tada,
  sadtrombone,
};

// In-browser synthesized version (the fallback).
function playSynth(name: SfxName): void {
  try {
    PLAYERS[name]?.(audio());
  } catch {
    // Audio not allowed yet (no user gesture) — ignore.
  }
}

// Only one sound effect at a time: let the current one FINISH, and ignore any
// new triggers until it does (rather than cutting it off).
let busy = false;
let busyTimer: ReturnType<typeof setTimeout> | null = null;

function freeWhenDone(el: HTMLAudioElement) {
  busy = true;
  const release = () => {
    busy = false;
    if (busyTimer) clearTimeout(busyTimer);
    busyTimer = null;
  };
  el.addEventListener("ended", release, { once: true });
  el.addEventListener("error", release, { once: true });
  // Safety net in case "ended" never fires — don't get stuck busy forever.
  busyTimer = setTimeout(release, 12000);
}

export function playSfx(name: SfxName): void {
  if (busy) return; // a sound is already playing — let it finish

  // Prefer a real recorded clip at /public/sfx/<name>.mp3 — much better quality.
  // If it's missing or can't play, fall back to the synthesized version, so the
  // app still works with zero audio files.
  try {
    const el = new Audio(`/sfx/${name}.mp3`);
    el.volume = 1;
    freeWhenDone(el);
    el.play().catch(() => {
      busy = false;
      if (busyTimer) clearTimeout(busyTimer);
      playSynth(name);
    });
  } catch {
    busy = false;
    playSynth(name);
  }
}

// Call once on a user gesture (e.g. clicking "Start") so the AudioContext is
// unlocked and later SFX from remotes can play without interaction.
export function unlockAudio(): void {
  audio();
}
