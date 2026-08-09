// Single source of truth for the app's version and changelog.
//
// Bump `APP_VERSION` (and prepend a matching CHANGELOG entry) whenever we ship a
// user-visible feature. On the host screen the "What's new" modal shows every
// CHANGELOG entry newer than the version this device last saw. Keep the
// `package.json` "version" field in sync by hand when you bump this.

export const APP_VERSION = "0.2.0";

export type ChangelogEntry = {
  version: string;
  date: string; // ISO date, e.g. "2026-08-09"
  items: string[];
};

// Newest first. Each entry is a short, plain-language list of what changed.
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.2.0",
    date: "2026-08-09",
    items: [
      "Guided tour for first-time hosts — highlights the join code, video stage, tabs, and Controls menu.",
      "Sing-to-score with your phone mic, plus a live pitch ribbon and end-of-song rankings.",
      "Random singer wheel to pick who's up next.",
      "Synced lyrics for the now-playing song.",
    ],
  },
];

// Compare two dotted numeric versions. Returns true when `a` is strictly newer
// than `b`. Non-numeric or missing segments are treated as 0, so "0.2" and
// "0.2.0" compare equal.
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}
