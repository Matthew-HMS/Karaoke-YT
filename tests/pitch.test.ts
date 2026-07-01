import { describe, expect, it } from "vitest";
import {
  centsFromNearestSemitone,
  detectPitch,
  detectPitchHz,
  emptyScore,
  foldScore,
  foldScoreVsRef,
  freqToMidi,
  midiToFreq,
  noteName,
  octaveFoldedDelta,
  pcmToContour,
  pitchMatchScore,
  rankScores,
  referenceMidiAt,
  scoreOutOf100,
  tuneScore,
  type PitchSample,
  type ScoreState,
} from "@/lib/pitch";

// Build one window of a pure sine at `hz` for the detector to analyze.
function sine(hz: number, sampleRate = 44100, size = 2048): Float32Array {
  const buf = new Float32Array(size);
  for (let i = 0; i < size; i++) buf[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return buf;
}

describe("note math", () => {
  it("maps A4 = 440Hz = MIDI 69", () => {
    expect(freqToMidi(440)).toBeCloseTo(69, 5);
    expect(midiToFreq(69)).toBeCloseTo(440, 5);
    expect(noteName(69)).toBe("A4");
    expect(noteName(60)).toBe("C4");
  });

  it("measures cents off the nearest semitone", () => {
    expect(centsFromNearestSemitone(69)).toBeCloseTo(0, 5);
    expect(centsFromNearestSemitone(69.4)).toBeCloseTo(40, 5);
    expect(centsFromNearestSemitone(68.75)).toBeCloseTo(-25, 5);
  });

  it("rewards in-tune notes and penalizes pitches between notes", () => {
    expect(tuneScore(69)).toBeCloseTo(1, 5);
    expect(tuneScore(69.5)).toBeLessThan(0.3); // halfway between = poor (forgiving curve)
    expect(tuneScore(69.1)).toBeGreaterThan(tuneScore(69.3));
  });
});

describe("detectPitchHz", () => {
  it("recovers the fundamental of a pure tone", () => {
    for (const hz of [110, 220, 440, 523.25]) {
      const detected = detectPitchHz(sine(hz), 44100);
      // Within ~2% (< a third of a semitone) is plenty for pitch tracking.
      expect(Math.abs(detected - hz)).toBeLessThan(hz * 0.02);
    }
  });

  it("returns -1 on silence", () => {
    expect(detectPitchHz(new Float32Array(2048), 44100)).toBe(-1);
  });

  it("rejects out-of-range rumble", () => {
    expect(detectPitchHz(sine(30), 44100)).toBe(-1);
  });

  it("reports high clarity for a clean tone, low/none for noise", () => {
    expect(detectPitch(sine(220), 44100).clarity).toBeGreaterThan(0.9);
    const noise = new Float32Array(2048);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
    const n = detectPitch(noise, 44100);
    // White noise is aperiodic — either rejected, or at most weak clarity.
    expect(n.hz === -1 || n.clarity < 0.9).toBe(true);
  });

  it("resists octave errors on a tone with a strong 2nd harmonic", () => {
    // Fundamental 150Hz + a louder 2nd harmonic (300Hz) — plain autocorrelation
    // is prone to picking the harmonic; MPM should hold the fundamental.
    const sr = 44100;
    const buf = new Float32Array(2048);
    for (let i = 0; i < buf.length; i++) {
      const t = i / sr;
      buf[i] =
        0.5 * Math.sin(2 * Math.PI * 150 * t) +
        0.8 * Math.sin(2 * Math.PI * 300 * t);
    }
    expect(detectPitchHz(buf, sr)).toBeCloseTo(150, -1); // within ~5Hz
  });
});

describe("pcmToContour", () => {
  it("tracks a tone that steps up partway through the buffer", () => {
    const sr = 16000;
    const fps = 12;
    const seconds = 2;
    const pcm = new Float32Array(sr * seconds);
    // First half 220Hz (A3 ≈ midi 57), second half 330Hz (E4 ≈ midi 64).
    for (let i = 0; i < pcm.length; i++) {
      const hz = i < pcm.length / 2 ? 220 : 330;
      pcm[i] = Math.sin((2 * Math.PI * hz * i) / sr);
    }
    const contour = pcmToContour(pcm, sr, fps);
    expect(contour.length).toBeGreaterThan(10);
    const first = contour[2].midi; // early, settled
    const last = contour[contour.length - 3].midi; // late, settled
    expect(first).toBeCloseTo(57, 0);
    expect(last).toBeCloseTo(64, 0);
  });
});

describe("scoring", () => {
  const voiced = (midi: number): PitchSample => ({ singer: "x", midi, clarity: 1 });

  it("starts at 0 and ignores unvoiced samples", () => {
    let s = emptyScore;
    s = foldScore(s, { singer: "x", midi: -1, clarity: 0 });
    expect(scoreOutOf100(s)).toBe(0);
  });

  it("scores steady in-tune singing high and smeared singing low", () => {
    let inTune = emptyScore;
    let flat = emptyScore;
    for (let i = 0; i < 50; i++) {
      inTune = foldScore(inTune, voiced(60));
      flat = foldScore(flat, voiced(60.5));
    }
    expect(scoreOutOf100(inTune)).toBeGreaterThan(90);
    // Smeared singing scores clearly lower than in-tune — but the display is
    // floored into a feel-good band (SCORE_FLOOR..100), so "low" isn't near 0.
    expect(scoreOutOf100(flat)).toBeLessThan(scoreOutOf100(inTune));
    expect(scoreOutOf100(flat)).toBeLessThan(75);
    expect(scoreOutOf100(flat)).toBeGreaterThanOrEqual(60);
  });

  it("ranks singers high→low and drops anyone who never sang", () => {
    const fold = (...midis: number[]) =>
      midis.reduce<ScoreState>((s, m) => foldScore(s, voiced(m)), emptyScore);
    const scores = new Map<string, ScoreState>([
      ["Ava", fold(60, 60, 60)], // dead on
      ["Bo", fold(60.4, 60.4)], // off
      ["Cy", emptyScore], // never sang
    ]);
    const ranked = rankScores(scores);
    expect(ranked.map((r) => r.singer)).toEqual(["Ava", "Bo"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe("reference-melody match (Tier 3)", () => {
  const voiced = (midi: number): PitchSample => ({ singer: "x", midi, clarity: 1 });

  it("folds the sung↔target distance into the nearest octave (-6..+6)", () => {
    expect(octaveFoldedDelta(60, 60)).toBe(0);
    expect(octaveFoldedDelta(60, 72)).toBe(0); // octave above = same pitch class
    expect(octaveFoldedDelta(48, 60)).toBe(0); // octave below = same pitch class
    expect(octaveFoldedDelta(61, 60)).toBe(1); // a semitone sharp
    expect(octaveFoldedDelta(59, 60)).toBe(-1); // a semitone flat
    // A tritone is equidistant; folding lands it at -6 (never beyond ±6).
    expect(Math.abs(octaveFoldedDelta(66, 60))).toBe(6);
  });

  it("rewards the right note (any octave) and punishes wrong notes", () => {
    expect(pitchMatchScore(60, 60)).toBeCloseTo(1, 5);
    expect(pitchMatchScore(72, 60)).toBeCloseTo(1, 5); // an octave up still matches
    expect(pitchMatchScore(60.5, 60)).toBeGreaterThan(0.8); // close enough = green
    // Monotonic falloff — further off scores lower (curve is forgiving on purpose).
    expect(pitchMatchScore(61, 60)).toBeLessThan(pitchMatchScore(60.5, 60));
    expect(pitchMatchScore(62, 60)).toBeLessThan(pitchMatchScore(61, 60));
    expect(pitchMatchScore(62, 60)).toBeLessThan(0.2); // two semitones = clear miss
  });

  it("scores a singer who tracks the melody far above one who holds a steady wrong note", () => {
    const melody = [60, 62, 64, 65, 67]; // a little run
    let onMelody = emptyScore;
    let droning = emptyScore;
    for (const target of melody) {
      onMelody = foldScoreVsRef(onMelody, voiced(target), target); // hits each
      droning = foldScoreVsRef(droning, voiced(60), target); // sits on one note
    }
    expect(scoreOutOf100(onMelody)).toBeGreaterThan(95);
    expect(scoreOutOf100(droning)).toBeLessThan(scoreOutOf100(onMelody));
  });

  it("falls back to self-tune scoring when there is no target (-1)", () => {
    let s = emptyScore;
    for (let i = 0; i < 10; i++) s = foldScoreVsRef(s, voiced(60), -1);
    expect(scoreOutOf100(s)).toBeGreaterThan(95); // dead-on a note = in tune
  });

  it("reads the reference note at a song-time, or -1 out of range", () => {
    const midis = [60, 61, 62, 63]; // 4 frames
    expect(referenceMidiAt(midis, 12, 0)).toBe(60);
    expect(referenceMidiAt(midis, 12, 1 / 12)).toBe(61); // one frame in
    expect(referenceMidiAt(midis, 12, 10)).toBe(-1); // past the end
    expect(referenceMidiAt(midis, 12, -1)).toBe(-1);
    expect(referenceMidiAt(null, 12, 0)).toBe(-1);
    expect(referenceMidiAt([], 12, 0)).toBe(-1);
  });
});
