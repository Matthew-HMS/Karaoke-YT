"use client";

// "What's new" modal shown on the host screen the first time a device loads the
// app after an update. The host page decides which CHANGELOG entries are newer
// than this device's last-seen version and passes them in; dismissing stamps the
// current version so it won't show again until the next release.

import { AnimatePresence, motion } from "framer-motion";
import type { ChangelogEntry } from "@/lib/version";

type Props = {
  entries: ChangelogEntry[];
  onDismiss: () => void;
};

export function WhatsNewModal({ entries, onDismiss }: Props) {
  return (
    <AnimatePresence>
      {entries.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          onClick={onDismiss}
        >
          <motion.div
            initial={{ scale: 0.8, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
            className="max-h-[80vh] w-[min(90%,440px)] overflow-y-auto rounded-3xl border border-white/10 bg-[#12121a] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center">
              <div className="text-4xl">🎉</div>
              <h2 className="mt-2 text-2xl font-black">
                <span className="bg-gradient-to-r from-fuchsia-400 to-pink-400 bg-clip-text text-transparent">
                  What&rsquo;s new
                </span>
              </h2>
            </div>

            <div className="mt-5 space-y-5">
              {entries.map((entry) => (
                <div key={entry.version}>
                  <div className="flex items-baseline gap-2">
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-bold tracking-wide text-white/80">
                      v{entry.version}
                    </span>
                    <span className="text-[11px] text-white/30">
                      {entry.date}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {entry.items.map((item, i) => (
                      <li
                        key={i}
                        className="flex gap-2 text-sm leading-snug text-white/80"
                      >
                        <span className="text-fuchsia-400">•</span>
                        <span className="min-w-0">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={onDismiss}
              className="mt-6 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 active:scale-95"
            >
              Got it
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
