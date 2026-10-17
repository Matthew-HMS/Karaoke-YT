// Lyrics translation to a user-chosen target language, shown under each line
// (meaning, as opposed to romaji which is pronunciation). A sibling of
// lib/romanize.ts — same "aligned 1:1, cached per video, chunk long songs" shape
// — but the target language is a parameter, so the cache is keyed by (videoId,
// lang) and we SKIP songs already in the chosen language.

import { aiJSON, aiJSONBatch, chunk } from "./aiCall";
import { linesHash, singleFlight } from "./singleflight";
import type { AiAccess } from "./llm";
import { getCachedTranslation, putCachedTranslation } from "./db";
import { TRANSLATE_LANGS, type TranslateLang } from "./translateLangs";

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

const SYSTEM = (langName: string) => `You translate song lyrics into ${langName}.
Rules:
- Input is a JSON array of lyric lines (strings), in order.
- Reply with ONLY a JSON array of the SAME length, no prose, no code fences.
- Output[i] is the ${langName} translation of input[i].
- Preserve line order and count exactly. Punctuation-only or empty lines map to "".
- If a line is already in ${langName}, return it unchanged.
- Translate the MEANING into natural ${langName}, not word-for-word.`;

// Force the LLM output back into an array the same length as `count`, so the UI's
// index-based interleaving never drifts. Missing entries become "".
export function alignTranslation(raw: unknown, count: number): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const v = arr[i];
    out.push(typeof v === "string" ? v.trim() : "");
  }
  return out;
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
  if (alreadyInLang(lines, lang)) return null; // already in target → nothing to show

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

  const langName = TRANSLATE_LANGS[lang].name;
  const prompt = (batch: string[]) => [
    { role: "system" as const, content: SYSTEM(langName) },
    { role: "user" as const, content: JSON.stringify(batch) },
  ];

  let out: string[];
  let missingChunk = false; // a whole chunk failed → show it, don't cache it
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
    missingChunk = raws.some((raw) => raw === null);
    out = raws.flatMap((raw, i) => alignTranslation(raw, batches[i].length));
  }

  // See lib/furigana.ts: a translation with a blank range must not be frozen in.
  if (!missingChunk) putCachedTranslation(videoId, lang, out, src);
  return out;
}
