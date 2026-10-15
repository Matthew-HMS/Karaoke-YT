// Format seconds as m:ss (or h:mm:ss for long videos).
export function formatTime(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) totalSec = 0;
  const s = Math.floor(totalSec % 60);
  const m = Math.floor((totalSec / 60) % 60);
  const h = Math.floor(totalSec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Format a wait in seconds as a rough human span ("40s", "12 min", "5 hours") —
// used for the AI rate-limit cooldown, which the gateway reports in seconds but
// which can run to hours. Deliberately coarse: it's a "come back later" hint,
// not a countdown.
export function formatWait(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "a moment";
  if (sec < 90) return `${Math.round(sec)}s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} min`;
  const hours = Math.round(sec / 3600);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
