import { useEffect } from "react";

// Hold a Screen Wake Lock while `active` so the device won't dim/sleep — handy
// for a phone-as-host, where a locked screen would pause the YouTube embed.
// The browser auto-releases the lock whenever the page is hidden (tab switch,
// screen off), so we re-acquire it on `visibilitychange` once we're visible
// again. Quietly no-ops where the API is unsupported (notably iOS < 16.4).
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !navigator.wakeLock) {
      return;
    }

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await lock.release();
          return;
        }
        sentinel = lock;
      } catch {
        // Denied (e.g. low battery) or unsupported — nothing we can do.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !sentinel) acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
