// Dictionary furigana: the same `FuriganaSegment[][]` contract as the model
// path in lib/furigana.ts, produced offline by a morphological analyser
// (kuromoji + IPADIC) instead of an LLM call.
//
// WHY this is the primary path now. Measured on the local library (23 Japanese
// songs, 955 kanji lines): 3155/3157 kanji annotated and the reconstruction
// guard tripped ZERO times, at ~33ms a song with no key, no quota and no
// network. The model path reached 98.8% on the one song both had produced, took
// ~12.5s cold, and needed the whole repair apparatus (`repairDroppedLines`,
// `tries`, `MAX_ATTEMPTS`) because its slips are RANDOM — the same request
// returned 120/120/124 readings on three runs. A dictionary's mistakes are
// systematic instead, so each one can be fixed here, permanently (OVERRIDES).
//
// The model is still better at context, so it keeps two jobs: the ↻ re-roll
// (`refresh`) and repairing whatever lines this leaves bare.

import path from "node:path";
import { createRequire } from "node:module";
import kuromoji from "kuromoji";
import type { IpadicFeatures, Tokenizer } from "kuromoji";
import { toHiragana } from "wanakana";
import type { FuriganaSegment } from "@/lib/types";

const KANJI_RE = /[一-龯々]/;
const HIRAGANA_RE = /[぀-ゟ]/;

// IPADIC picks the wrong gloss for these in running text, every time. A
// longest-match override applied BEFORE tokenizing is the standard way to patch
// a dictionary analyser; each entry maps a surface string to its segmentation.
// Found by hand-adjudicating readings against songs in the library — add to it
// whenever a wrong reading turns up, since the error will be reproducible.
const OVERRIDES: ReadonlyArray<readonly [string, readonly FuriganaSegment[]]> = (
  [
    // 愛おしい / 愛しい are いとおしい / いとしい; IPADIC reads the 愛 as あい.
    ["愛おし", [{ t: "愛", r: "いと" }, { t: "おし" }]],
    ["愛しい", [{ t: "愛", r: "いと" }, { t: "しい" }]],
    // 他 before a particle is ほか, not た.
    ["他の", [{ t: "他", r: "ほか" }, { t: "の" }]],
    ["他に", [{ t: "他", r: "ほか" }, { t: "に" }]],
    ["他は", [{ t: "他", r: "ほか" }, { t: "は" }]],
    // IPADIC reads these as the counter (いちにん / ににん).
    ["一人", [{ t: "一人", r: "ひとり" }]],
    ["二人", [{ t: "二人", r: "ふたり" }]],
    // Lyrics often write these with half-width digits.
    ["1人", [{ t: "1人", r: "ひとり" }]],
    ["2人", [{ t: "2人", r: "ふたり" }]],
    // 通り is voiced after いつも.
    ["いつも通り", [{ t: "いつも" }, { t: "通", r: "どお" }, { t: "り" }]],
    // Rendaku in a compound IPADIC does not list: it splits 一番星 into
    // 一番 + 星 and so never voices the 星. Same shape for 流れ星.
    ["一番星", [{ t: "一番星", r: "いちばんぼし" }]],
    ["流れ星", [{ t: "流", r: "なが" }, { t: "れ" }, { t: "星", r: "ぼし" }]],
  ] as ReadonlyArray<readonly [string, readonly FuriganaSegment[]]>
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

// ---------------------------------------------------------------------------
// Tokenizer: loaded once, lazily. The IPADIC dictionary costs ~300MB of RSS and
// 1-2s to load, so a pod that never serves a Japanese song never pays for it —
// which matters here, since this image has been OOM-killed before.
// ---------------------------------------------------------------------------

let pending: Promise<Tokenizer<IpadicFeatures>> | null = null;

function dicPath(): string {
  // Resolve the package rather than hardcoding node_modules. cwd comes first
  // because it holds node_modules both in dev and in the image (/app), and
  // because this project transpiles as CJS, where `import.meta.url` is empty —
  // it is only the fallback, for a caller running from somewhere else entirely.
  const bases: string[] = [path.join(process.cwd(), "package.json")];
  const here = typeof import.meta === "object" ? import.meta.url : undefined;
  if (here) bases.push(here);

  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve("kuromoji/package.json");
      return path.join(path.dirname(resolved), "dict");
    } catch {
      // try the next base
    }
  }
  throw new Error("kuromoji dictionary not found");
}

function tokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  // A rejected promise must not be cached, or one transient failure disables
  // readings for the life of the process.
  pending ??= new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
    kuromoji.builder({ dicPath: dicPath() }).build((err, built) => {
      if (err) reject(err);
      else resolve(built);
    });
  }).catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}

// ---------------------------------------------------------------------------
// Reading alignment
// ---------------------------------------------------------------------------

// Split a surface form into alternating kanji / non-kanji runs.
function runs(surface: string): { text: string; kanji: boolean }[] {
  const out: { text: string; kanji: boolean }[] = [];
  for (const ch of surface) {
    const kanji = KANJI_RE.test(ch);
    const last = out[out.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else out.push({ text: ch, kanji });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Spread one token's reading across its kanji runs, using its kana runs as
// anchors: 過ごした / すごした → 過(す) + ごした. Returns null when the reading
// cannot be aligned (ateji, latin, numbers, unknown words) so the caller can
// emit the surface bare instead of inventing a reading for it.
export function alignReading(surface: string, reading: string | undefined): FuriganaSegment[] | null {
  const parts = runs(surface);
  if (!parts.some((p) => p.kanji)) return [{ t: surface }];

  const hira = toHiragana(reading ?? "", { passRomaji: true });
  if (!HIRAGANA_RE.test(hira)) return null;

  // A token that is all kanji takes the whole reading.
  if (parts.length === 1) return [{ t: surface, r: hira }];

  const pattern =
    "^" +
    parts.map((p) => (p.kanji ? "([\\u3040-\\u309f]+?)" : escapeRe(toHiragana(p.text)))).join("") +
    "$";
  const m = hira.match(new RegExp(pattern));
  if (!m) return null;

  let group = 1;
  return parts.map((p) => (p.kanji ? { t: p.text, r: m[group++] } : { t: p.text }));
}

// Merge neighbouring unannotated segments, so the output has the same shape the
// model produces ({"t":"せてくれた"}, not one segment per character).
function compact(segs: FuriganaSegment[]): FuriganaSegment[] {
  const out: FuriganaSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.r === undefined && last && last.r === undefined) last.t += s.t;
    else out.push({ ...s });
  }
  return out;
}

function segmentLine(line: string, tk: Tokenizer<IpadicFeatures>): FuriganaSegment[] {
  if (!line || !KANJI_RE.test(line)) return [{ t: line }];

  for (const [needle, replacement] of OVERRIDES) {
    const at = line.indexOf(needle);
    if (at === -1) continue;
    const before = line.slice(0, at);
    const after = line.slice(at + needle.length);
    return compact([
      ...(before ? segmentLine(before, tk) : []),
      ...replacement.map((s) => ({ ...s })),
      ...(after ? segmentLine(after, tk) : []),
    ]);
  }

  const segs: FuriganaSegment[] = [];
  for (const token of tk.tokenize(line)) {
    const surface = token.surface_form;
    if (!KANJI_RE.test(surface)) {
      segs.push({ t: surface });
      continue;
    }
    const aligned = alignReading(surface, token.reading);
    if (aligned) segs.push(...aligned);
    else segs.push({ t: surface });
  }

  const out = compact(segs);
  // The same all-or-nothing guard as coerceLine: a reading whose segments don't
  // rejoin to the exact line would render ruby over the wrong characters.
  return out.map((s) => s.t).join("") === line ? out : [{ t: line }];
}

/**
 * Annotate every line offline. Never throws for a line it cannot read — that
 * line comes back as plain text, which `droppedLineIndexes` then reports so the
 * model can repair it. Throws only if the dictionary itself cannot be loaded.
 */
export async function furiganaLinesLocal(lines: string[]): Promise<FuriganaSegment[][]> {
  const tk = await tokenizer();
  return lines.map((line) => segmentLine(line, tk));
}
