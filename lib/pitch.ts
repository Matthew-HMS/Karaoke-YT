// Monophonic pitch detection + scoring helpers. Pure functions (no DOM / Web
// Audio), so they're unit-testable and run identically on phone and server.
//
// We have NO reference melody (the song plays inside a cross-origin YouTube
// iframe we can't tap), so this is "Tier 1": detect the singer's own pitch from
// their phone mic and score how *in-tune-to-itself* they sing — closeness to the
// nearest semitone + steadiness — rather than matching a ground-truth chart.

export const A4_HZ = 440;

// Vocal fundamentals live roughly here; anything outside is noise/harmonic
// garbage and gets rejected so the ribbon doesn't jump to octave errors.
export const MIN_VOCAL_HZ = 70; // ~ D2
export const MAX_VOCAL_HZ = 1100; // ~ C#6

const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / A4_HZ);
}

export function midiToFreq(midi: number): number {
  return A4_HZ * 2 ** ((midi - 69) / 12);
}

// e.g. 69 -> "A4", 60 -> "C4". Rounds to the nearest semitone.
export function noteName(midi: number): string {
  const m = Math.round(midi);
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

// How far the sung pitch sits from the nearest semitone, in cents (-50..+50).
// 0 = dead-on a note; ±50 = exactly between two notes.
export function centsFromNearestSemitone(midi: number): number {
  return (midi - Math.round(midi)) * 100;
}

// Per-sample "in-tune-ness" in 0..1: a Gaussian that rewards sitting near a real
// note and falls off for pitches smeared between notes. Fairly forgiving (~40
// cents to still score well) — phone-mic pitch on a noisy room is jittery, and a
// punishing curve makes it near-impossible to ever see green.
export function tuneScore(midi: number): number {
  const cents = centsFromNearestSemitone(midi);
  return Math.exp(-((cents / 40) ** 2));
}

// ---- Reference-melody match (Tier 3 "Milestone B") ----
//
// Self-tune scoring (above) rewards holding ANY steady note. Karaoke scoring
// rewards holding the RIGHT note — the one the song's melody plays right now.
// These compare a sung pitch to a reference-contour note.

// Signed distance in semitones between a sung note and a target note, folded
// into the nearest octave (-6..+6). Singers reproduce a melody in whatever
// octave fits their range (a man an octave below a female vocal, say), so we
// compare pitch *classes*, not absolute octaves.
export function octaveFoldedDelta(midi: number, target: number): number {
  const d = (((midi - target) % 12) + 12) % 12; // 0..12
  return d > 6 ? d - 12 : d; // -6..+6
}

// Per-sample match to a reference note in 0..1: a Gaussian on the octave-folded
// distance. Forgiving on purpose (σ≈1.4 semitones): dead-on = 1.0, ~½ semitone
// off ≈ 0.88, a full semitone ≈ 0.60, ~2 semitones ≈ 0.13. Loose enough that a
// singer who's roughly on the melody (allowing for mic jitter + A/V lag) lights
// up green, but a clearly wrong note still tanks.
export function pitchMatchScore(midi: number, target: number): number {
  const semis = octaveFoldedDelta(midi, target);
  return Math.exp(-((semis / 1.4) ** 2));
}

// Autocorrelation pitch detector. `buf` is a window of time-domain samples in
// [-1, 1] (from AnalyserNode.getFloatTimeDomainData). Returns the fundamental in
// Hz, or -1 when the input is too quiet/noisy to call a pitch. Adapted from the
// well-known ACF approach (Chris Wilson's PitchDetect), with a vocal-range
// clamp and parabolic peak interpolation for sub-bin accuracy.
// McLeod Pitch Method (MPM): build the Normalized Square Difference Function
// (NSDF), pick the first "key maximum" that clears a fraction of the strongest
// one, and parabolically interpolate it. NSDF self-normalizes per lag, which
// makes MPM markedly more robust to the octave errors plain autocorrelation
// trips on (it would happily lock onto a strong harmonic). Returns the
// fundamental in Hz plus a 0..1 clarity (the NSDF peak height = how periodic
// the window is — a real confidence, unlike a raw amplitude proxy). hz = -1 when
// the window is too quiet/noisy/aperiodic to call a pitch.
const MPM_K = 0.9; // accept the first key max ≥ this × the strongest one
const MPM_MIN_CLARITY = 0.5; // below this, treat the window as unpitched

export function detectPitch(
  buf: Float32Array,
  sampleRate: number
): { hz: number; clarity: number } {
  const size = buf.length;

  // RMS gate: ignore near-silence so silence doesn't register as a low note.
  let rms = 0;
  for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return { hz: -1, clarity: 0 };

  // Only lags inside the vocal range can be the fundamental.
  const minLag = Math.max(1, Math.floor(sampleRate / MAX_VOCAL_HZ));
  const maxLag = Math.min(size - 1, Math.floor(sampleRate / MIN_VOCAL_HZ));
  if (maxLag <= minLag) return { hz: -1, clarity: 0 };

  // NSDF: n(tau) = 2·Σ x[j]·x[j+tau] / Σ (x[j]² + x[j+tau]²), in [-1, 1].
  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = 0; tau <= maxLag; tau++) {
    let acf = 0;
    let denom = 0;
    for (let j = 0; j < size - tau; j++) {
      acf += buf[j] * buf[j + tau];
      denom += buf[j] * buf[j] + buf[j + tau] * buf[j + tau];
    }
    nsdf[tau] = denom > 0 ? (2 * acf) / denom : 0;
  }

  // Collect key maxima: the peak within each positive lobe (a stretch where
  // the NSDF is above zero). Skip the lobe attached to tau=0 (the self-match).
  let tau = 1;
  while (tau <= maxLag && nsdf[tau] > 0) tau++; // past the zero-lag lobe
  let highest = 0;
  let bestLag = -1;
  let bestVal = -Infinity;
  let inLobe = false;
  let lobeLag = -1;
  let lobeVal = -Infinity;
  // First pass: find every lobe peak and remember the strongest overall.
  const peaks: { lag: number; val: number }[] = [];
  for (; tau <= maxLag; tau++) {
    if (nsdf[tau] > 0) {
      if (!inLobe) {
        inLobe = true;
        lobeVal = -Infinity;
        lobeLag = -1;
      }
      if (nsdf[tau] > lobeVal) {
        lobeVal = nsdf[tau];
        lobeLag = tau;
      }
    } else if (inLobe) {
      peaks.push({ lag: lobeLag, val: lobeVal });
      if (lobeVal > highest) highest = lobeVal;
      inLobe = false;
    }
  }
  if (inLobe && lobeLag > 0) {
    peaks.push({ lag: lobeLag, val: lobeVal });
    if (lobeVal > highest) highest = lobeVal;
  }
  if (highest < MPM_MIN_CLARITY) return { hz: -1, clarity: 0 };

  // Choose the FIRST (lowest-lag = highest-pitch) peak that clears the
  // threshold — this is what defeats octave errors.
  const threshold = MPM_K * highest;
  for (const p of peaks) {
    if (p.val >= threshold && p.lag >= minLag) {
      bestLag = p.lag;
      bestVal = p.val;
      break;
    }
  }
  if (bestLag < 0) return { hz: -1, clarity: 0 };

  // Parabolic interpolation around the chosen NSDF peak.
  let lag = bestLag;
  if (bestLag > 0 && bestLag < maxLag) {
    const a = nsdf[bestLag - 1];
    const b = nsdf[bestLag];
    const c = nsdf[bestLag + 1];
    const d = a - 2 * b + c;
    if (d !== 0) lag = bestLag + (0.5 * (a - c)) / d;
  }

  const hz = sampleRate / lag;
  if (hz < MIN_VOCAL_HZ || hz > MAX_VOCAL_HZ) return { hz: -1, clarity: 0 };
  return { hz, clarity: Math.max(0, Math.min(1, bestVal)) };
}

// Convenience wrapper for callers that only need the frequency.
export function detectPitchHz(buf: Float32Array, sampleRate: number): number {
  return detectPitch(buf, sampleRate).hz;
}

// One detected pitch sample, sent phone -> server -> host ~20x/sec.
export type PitchSample = {
  singer: string; // who is singing (so the host can label the ribbon)
  midi: number; // detected note number (float), or -1 for silence/unvoiced
  clarity: number; // 0..1 periodicity confidence (NSDF peak) for color + scoring
};

// Running performance score. Folded one voiced sample at a time on the host so
// the meter can update live and we don't need the whole take in memory.
export type ScoreState = {
  sum: number; // accumulated per-sample tune scores (0..1 each)
  voiced: number; // number of voiced samples counted
};

export const emptyScore: ScoreState = { sum: 0, voiced: 0 };

export function foldScore(state: ScoreState, sample: PitchSample): ScoreState {
  if (sample.midi < 0 || sample.clarity < 0.3) return state; // skip unvoiced
  // Clarity is only a GATE (above), not a multiplier — don't dock points for
  // singing softly/breathily when the pitch is right; that just made every score
  // feel low.
  return {
    sum: state.sum + tuneScore(sample.midi),
    voiced: state.voiced + 1,
  };
}

// Like foldScore, but scores against the song's reference melody: credit for
// hitting the RIGHT note (octave-folded), not merely a steady in-tune one. Where
// there's no target — an instrumental gap, or the contour isn't generated yet —
// it falls back to self-tune scoring so the meter still moves. `targetMidi` is
// the reference note at the song-time this sample was sung (see referenceMidiAt),
// or -1 when none is known.
export function foldScoreVsRef(
  state: ScoreState,
  sample: PitchSample,
  targetMidi: number
): ScoreState {
  if (sample.midi < 0 || sample.clarity < 0.3) return state; // skip unvoiced
  // Clarity gates but doesn't multiply (see foldScore).
  const per =
    targetMidi >= 0
      ? pitchMatchScore(sample.midi, targetMidi)
      : tuneScore(sample.midi);
  return {
    sum: state.sum + per,
    voiced: state.voiced + 1,
  };
}

// Displayed score. Returns 0 before anyone has sung, but once you've actually
// sung it's mapped into a feel-good SCORE_FLOOR..100 band — karaoke should feel
// rewarding, and the raw average rarely climbs near 1.0 on a phone mic. The
// relative ordering (for the leaderboard) is preserved.
export const SCORE_FLOOR = 60;
export function scoreOutOf100(state: ScoreState): number {
  if (state.voiced === 0) return 0;
  const raw = state.sum / state.voiced; // 0..1
  return Math.round(SCORE_FLOOR + raw * (100 - SCORE_FLOOR));
}

// One singer's final tally, for the live leaderboard + end-of-song score card.
export type SingerScore = {
  singer: string;
  score: number; // 0..100
  voiced: number; // voiced samples counted (a rough "how long they sang")
};

// Rank singers high→low, dropping anyone who never actually sang a note. Used
// for both the live leaderboard and the song-end card.
export function rankScores(
  scores: Map<string, ScoreState>
): SingerScore[] {
  return [...scores.entries()]
    .map(([singer, s]) => ({
      singer,
      score: scoreOutOf100(s),
      voiced: s.voiced,
    }))
    .filter((s) => s.voiced > 0)
    .sort((a, b) => b.score - a.score);
}

// ---- Reference contour (Tier 3): the song's own pitch line over time ----

// One point of a song's pitch contour. `t` is seconds from the song start;
// `midi` is the detected note (float), or -1 where no clear pitch was found.
export type ContourPoint = { t: number; midi: number };

// The reference note (float midi, or -1 unvoiced) at a given song-time, read
// from a flat per-frame contour at `fps`. Used to score / color a singer's
// sample against the melody at the moment they sang it. Out-of-range or empty
// returns -1 (no target → caller falls back to self-tune scoring).
export function referenceMidiAt(
  midis: number[] | null | undefined,
  fps: number,
  songTimeSec: number
): number {
  if (!midis || midis.length === 0 || !(songTimeSec >= 0)) return -1;
  const i = Math.round(songTimeSec * fps);
  if (i < 0 || i >= midis.length) return -1;
  return midis[i];
}

// Window size (samples) used per analysis frame when scanning a whole song.
export const CONTOUR_WINDOW = 2048;

// Number of analysis frames for a PCM buffer at the given frame rate (fps).
export function contourFrameCount(
  pcmLength: number,
  sampleRate: number,
  fps: number
): number {
  if (pcmLength < CONTOUR_WINDOW) return 0;
  const hop = sampleRate / fps;
  return Math.floor((pcmLength - CONTOUR_WINDOW) / hop) + 1;
}

// Analyze a single frame of a longer PCM buffer (used both by pcmToContour and
// by the server's chunked, yielding generator so the two never diverge).
export function contourFrame(
  pcm: Float32Array,
  sampleRate: number,
  fps: number,
  index: number
): ContourPoint {
  const hop = sampleRate / fps;
  const start = Math.round(index * hop);
  const frame = pcm.subarray(start, start + CONTOUR_WINDOW);
  // detectPitch already rejects below MPM_MIN_CLARITY; don't add a second,
  // stricter gate here or a full-mix contour comes out full of -1 gaps (the
  // "target line keeps disappearing" symptom). Median-smoothing cleans the rest.
  const { hz } = detectPitch(frame, sampleRate);
  const midi = hz > 0 ? freqToMidi(hz) : -1;
  return { t: index / fps, midi };
}

// Median-smooth the midi values over a small odd window, bridging tiny gaps.
// Tames the lone octave-jumps/dropouts a full-mix scan throws off, without
// blurring real note changes. Keeps `t`; leaves -1 (unvoiced) points as -1.
export function medianSmoothContour(
  points: ContourPoint[],
  window = 5
): ContourPoint[] {
  const half = Math.floor(window / 2);
  return points.map((p, i) => {
    if (p.midi < 0) return p;
    const around: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
      if (points[j].midi >= 0) around.push(points[j].midi);
    }
    around.sort((a, b) => a - b);
    return { t: p.t, midi: around[Math.floor(around.length / 2)] ?? p.midi };
  });
}

// Whole-buffer convenience (sync) — used in tests. The server generates the
// contour in a chunked, event-loop-yielding loop instead (see lib/reference.ts)
// so a multi-second scan can't block Socket.IO.
export function pcmToContour(
  pcm: Float32Array,
  sampleRate: number,
  fps = 12
): ContourPoint[] {
  const count = contourFrameCount(pcm.length, sampleRate, fps);
  const points: ContourPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push(contourFrame(pcm, sampleRate, fps, i));
  }
  return medianSmoothContour(points);
}
