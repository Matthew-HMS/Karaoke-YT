// Lyrics translation to a user-chosen target language, shown under each line
// (meaning, as opposed to romaji which is pronunciation). A sibling of
// lib/romanize.ts — same "aligned 1:1, cached per video, chunk long songs" shape
// — but the target language is a parameter, so the cache is keyed by (videoId,
// lang) and we SKIP songs already in the chosen language.

import {
  aiJSON,
  aiJSONBatch,
  chunk,
  numberLines,
  alignIndexed,
  repairIndexedGaps,
} from "./aiCall";
import { linesHash, singleFlight } from "./singleflight";
import type { AiAccess } from "./llm";
import { getCachedTranslation, putCachedTranslation } from "./db";
import { TRANSLATE_LANGS, type TranslateLang } from "./translateLangs";
import { toSimplified, toTraditional } from "./chineseScript";

export { TRANSLATE_LANGS, isTranslateLang } from "./translateLangs";
export type { TranslateLang } from "./translateLangs";

// Same chunk size as romaji — see lib/romanize.ts (long songs truncate at the
// model's ~4096-token output cap).
const CHUNK_LINES = 60;

// Coarse script detection, used ONLY to skip translating lyrics clearly already
// in the chosen language (so we don't spend a call translating zh→zh). We only
// trust the signal for CJK/kana/hangul targets; for Latin-script targets we let
// the LLM decide (it returns a line unchanged if it's already in that language).
const KANA_RE = /[ぁ-ゖ゠-ヿｦ-ﾝ]/;
const HANGUL_RE = /[가-힣]/;
const HAN_RE = /[一-鿿]/;

export function alreadyInLang(lines: string[], lang: TranslateLang): boolean {
  const text = lines.join("");
  if (lang === "ja") return KANA_RE.test(text); // kana ⇒ Japanese
  if (lang === "ko") return HANGUL_RE.test(text);
  if (lang === "zh" || lang === "zh-Hant") {
    return HAN_RE.test(text) && !KANA_RE.test(text) && !HANGUL_RE.test(text);
  }
  return false; // en/es/fr/de: can't tell apart by script → always attempt
}

// Free models drift between the two Chinese scripts unless told plainly, and
// even then not always — see enforceScript for the guarantee.
const SCRIPT_RULE: Partial<Record<TranslateLang, string>> = {
  "zh-Hant": "- Write ONLY Traditional Chinese characters (繁體字, as used in Taiwan), never Simplified (简体字). Simplified Chinese and Japanese kanji are NOT Traditional Chinese — translate them.",
  zh: "- Write ONLY Simplified Chinese characters (简体字), never Traditional (繁體字). Traditional Chinese and Japanese kanji are NOT Simplified Chinese — translate them.",
};

const SYSTEM = (lang: TranslateLang) => {
  const langName = TRANSLATE_LANGS[lang].name;
  return `You translate song lyrics into ${langName}.
Rules:
- Input is a JSON array of lyric lines, each written "<n>|<lyric>".
- Reply with ONLY a JSON array of strings, each written "<n>|<translation>", no prose, no code fences.
- Reuse the SAME <n> as the line you translated. One entry per input line, in order.
- Never merge two input lines into one entry and never split one into two — if two lines read as one sentence, still answer them separately, each with its own <n>.
- Punctuation-only or empty lines map to "<n>|".
- Translate EVERY part that is not ${langName}, whatever language it is in. Lyrics often mix languages (e.g. English phrases or whole English lines inside Japanese or Korean songs): translate the English too, never leave it as is. Only proper nouns (names, places, brands) may stay as written.
- If a line is already entirely in ${langName}, return it unchanged.
${SCRIPT_RULE[lang] ? SCRIPT_RULE[lang] + "\n" : ""}- Translate the MEANING into natural ${langName}, not word-for-word.`;
};

// The script half of SCRIPT_RULE, done by dictionary so it actually holds: any
// Simplified character the model let through in a Traditional translation (or
// the reverse) is converted. Not a translation — it never touches meaning.
function enforceScript(lines: string[], lang: TranslateLang): string[] {
  if (lang === "zh-Hant") return lines.map(toTraditional);
  if (lang === "zh") return lines.map(toSimplified);
  return lines;
}

// Force the LLM output back into an array the same length as `count`, so the
// UI's index-based interleaving never drifts. Each reply entry says which line
// it answers (see numberLines); an untagged reply is read positionally, as
// before. Lines nobody answered for become "" and are re-asked once.
export function alignTranslation(raw: unknown, count: number): string[] {
  return alignIndexed(raw, count);
}

// Translate a song's lyric lines into `lang` (one string per input line), or null
// when the song is already in that language (nothing to translate). Cached per
// (videoId, lang). Long songs are chunked like romaji.
export async function translateLines(
  videoId: string,
  lines: string[],
  lang: TranslateLang,
  opts: { access: AiAccess; clientId: string; refresh?: boolean }
): Promise<string[] | null> {
  if (alreadyInLang(lines, lang)) {
    // A Chinese song in the other script (Simplified lyrics, Traditional chosen)
    // only needs its characters converted — no model call. In the chosen script
    // already → nothing to show.
    const converted = enforceScript(lines, lang);
    return converted.some((l, i) => l !== lines[i]) ? converted : null;
  }

  const src = linesHash(lines);
  // One model call per (song, language) even with the whole room watching —
  // see lib/singleflight.ts.
  return singleFlight(`trans:${videoId}:${lang}:${opts.access.model}:${src}:${opts.refresh ? 1 : 0}`, () =>
    translate(videoId, lines, lang, src, opts)
  );
}

async function translate(
  videoId: string,
  lines: string[],
  lang: TranslateLang,
  src: string,
  opts: { access: AiAccess; clientId: string; refresh?: boolean }
): Promise<string[] | null> {
  if (!opts.refresh) {
    const cached = getCachedTranslation(videoId, lang, src);
    if (cached && cached.length === lines.length) return cached; // cache hit → free
  }

  const prompt = (batch: string[]) => [
    { role: "system" as const, content: SYSTEM(lang) },
    { role: "user" as const, content: JSON.stringify(numberLines(batch)) },
  ];

  // NOTE: blank lines are deliberately sent here, unlike furigana. They cost a
  // few tokens but keep the model's line discipline: measured on a 43-line song,
  // sending all 43 came back 42 long, while sending only the 39 filled lines
  // came back 36 — it ran four consecutive spoken-word lines together. Furigana
  // can detect and undo a merge by matching text; a translation can't, so the
  // cheapest defence is not to provoke it. Indexing (below) catches the rest.
  let out: string[];
  if (lines.length <= CHUNK_LINES) {
    const raw = await aiJSON<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      messages: prompt(lines),
      expect: lines.length,
    });
    out = alignTranslation(raw, lines.length);
  } else {
    const batches = chunk(lines, CHUNK_LINES);
    const raws = await aiJSONBatch<unknown>({
      access: opts.access,
      clientId: opts.clientId,
      batches: batches.map(prompt),
      expect: batches.map((b) => b.length),
    });
    out = raws.flatMap((raw, i) => alignTranslation(raw, batches[i].length));
  }

  // Second chance for the lines the reply skipped, before anything is cached —
  // a cache hit never re-calls, so a gap left here is a gap for good.
  out = await repairIndexedGaps({
    access: opts.access,
    system: SYSTEM(lang),
    answers: out,
    lines,
  });
  out = enforceScript(out, lang);

  // Cached even if a chunk came back empty. Not caching it meant the whole song
  // re-ran on every visit, which costs far more than the blank range is worth.
  // Anything the repair pass above could not fill stays blank; ↻ Refresh with
  // AI (which bypasses the cache) is the way to re-roll it.
  putCachedTranslation(videoId, lang, out, src);
  return out;
}
