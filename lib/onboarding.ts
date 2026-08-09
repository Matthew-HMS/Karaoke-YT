// Per-device onboarding state, stored in localStorage (like `host-volume` and
// `hostPanelWidth`). No server/socket involvement — whether a host has seen the
// tour or the latest changelog is purely a property of this browser.
//
// All access is guarded for `typeof window` so these can be called from client
// components without crashing during SSR. Reads should still happen inside an
// effect to avoid hydration mismatch.

const ONBOARDED_KEY = "singalong-onboarded-v1";
const LAST_SEEN_VERSION_KEY = "singalong-last-seen-version";

export function hasOnboarded(): boolean {
  if (typeof window === "undefined") return true; // never trigger during SSR
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true;
  }
}

export function setOnboarded(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    // ignore (private mode / storage disabled)
  }
}

export function clearOnboarded(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    // ignore
  }
}

export function getLastSeenVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_SEEN_VERSION_KEY);
  } catch {
    return null;
  }
}

export function setLastSeenVersion(v: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SEEN_VERSION_KEY, v);
  } catch {
    // ignore
  }
}
