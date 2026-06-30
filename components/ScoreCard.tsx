"use client";

// End-of-song score card. Shown on the host (TV) for a few seconds when a song
// finishes, ranking everyone who sang it. Driven by the per-singer tally the
// PitchRibbon hands up when it unmounts.

import { AnimatePresence, motion } from "framer-motion";
import type { SingerScore } from "@/lib/pitch";

// A little flavour line so the winner gets a reaction proportional to the score.
function blurb(score: number): string {
  if (score >= 90) return "Superstar! 🌟";
  if (score >= 75) return "Nailed it! 🎯";
  if (score >= 60) return "Nice pipes! 🎶";
  if (score >= 40) return "Not bad! 👏";
  return "Brave effort! 🎤";
}

type Props = {
  results: SingerScore[] | null;
  onDismiss: () => void;
};

export function ScoreCard({ results, onDismiss }: Props) {
  return (
    <AnimatePresence>
      {results && results.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={onDismiss}
        >
          <motion.div
            initial={{ scale: 0.8, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
            className="w-[min(90%,440px)] rounded-3xl border border-white/10 bg-[#12121a] p-6 shadow-2xl"
          >
            <div className="text-center text-sm font-medium uppercase tracking-wide text-white/40">
              Song complete
            </div>

            {/* Winner spotlight. */}
            <div className="mt-3 text-center">
              <div className="text-5xl font-black tabular-nums">
                <span className="bg-gradient-to-r from-fuchsia-400 to-pink-400 bg-clip-text text-transparent">
                  {results[0].score}
                </span>
              </div>
              <div className="mt-1 truncate text-xl font-bold">
                🏆 {results[0].singer}
              </div>
              <div className="text-sm text-fuchsia-300">
                {blurb(results[0].score)}
              </div>
            </div>

            {/* Runners-up. */}
            {results.length > 1 && (
              <ol className="mt-5 space-y-1.5">
                {results.slice(1, 5).map((r, i) => (
                  <li
                    key={r.singer}
                    className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-4 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-white/80">
                      {["🥈", "🥉"][i] ?? `${i + 2}.`} {r.singer}
                    </span>
                    <span className="text-sm font-bold tabular-nums text-white">
                      {r.score}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            <div className="mt-5 text-center text-xs text-white/30">
              Tap to dismiss
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
