// Client-safe language table for the lyrics-translation feature. Kept separate
// from lib/translate.ts (which imports the DB/LLM, i.e. server-only) so the
// Settings UI and useSettings can import the labels without pulling server code
// into the browser bundle.

// `label` is the native name shown in the dropdown; `name` is the English name
// used in the LLM prompt (lib/translate.ts). Single source of truth for both.
export const TRANSLATE_LANGS = {
  en: { label: "English", name: "English" },
  zh: { label: "中文", name: "Simplified Chinese" },
  "zh-Hant": { label: "繁體中文", name: "Traditional Chinese" },
  ja: { label: "日本語", name: "Japanese" },
  ko: { label: "한국어", name: "Korean" },
  es: { label: "Español", name: "Spanish" },
  fr: { label: "Français", name: "French" },
  de: { label: "Deutsch", name: "German" },
} as const;

export type TranslateLang = keyof typeof TRANSLATE_LANGS;

export function isTranslateLang(v: unknown): v is TranslateLang {
  return typeof v === "string" && v in TRANSLATE_LANGS;
}
