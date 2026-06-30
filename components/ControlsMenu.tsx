"use client";

// The phone/host floating controls menu: one button that opens a panel with
// Sing (mic pitch + name), the room's Target-line toggle, and Reactions (sound
// effects). Shared by BOTH the remote and the host (a host can be a phone too),
// so the two stay identical. The mic itself lives in a page-level `useMicPitch`
// hook passed in, so closing the panel never stops an in-progress take.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { SFX_BUTTONS } from "@/components/SongTabs";
import type { SfxName } from "@/lib/types";
import type { MicPitch } from "@/lib/useMicPitch";

type Props = {
  mic: MicPitch;
  name: string;
  onNameChange: (name: string) => void;
  showTarget: boolean;
  onToggleTarget: () => void;
  onSfx: (name: SfxName) => void;
  // Spin the random-singer wheel with the given name list.
  onSpin: (names: string[]) => void;
  // Names to pre-fill the wheel with on first use (the current queue's singers).
  suggestedNames?: string[];
  // Outer positioning — the remote is fixed to the viewport; the host sits in
  // its (relative) side panel.
  containerClassName?: string;
};

export function ControlsMenu({
  mic,
  name,
  onNameChange,
  showTarget,
  onToggleTarget,
  onSfx,
  onSpin,
  suggestedNames = [],
  containerClassName = "fixed bottom-5 right-5",
}: Props) {
  const [open, setOpen] = useState(false);

  // The wheel's editable roster. Seeded once from the queue's singers (or a
  // remembered list), then fully hand-editable.
  const [wheelNames, setWheelNames] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const seededRef = useRef(false);
  // Load a remembered list on mount; if there isn't one, we'll seed from the
  // queue's singers as soon as they're available (effect below).
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("wheel-names") || "[]");
      if (Array.isArray(saved) && saved.length) {
        setWheelNames(saved);
        seededRef.current = true;
      }
    } catch {
      /* ignore malformed storage */
    }
  }, []);
  // Seed from the current queue's singers the first time they show up.
  useEffect(() => {
    if (seededRef.current || suggestedNames.length === 0) return;
    setWheelNames([...new Set(suggestedNames.map((s) => s.trim()).filter(Boolean))]);
    seededRef.current = true;
  }, [suggestedNames]);
  // Persist edits so the roster survives a reload.
  useEffect(() => {
    if (seededRef.current) localStorage.setItem("wheel-names", JSON.stringify(wheelNames));
  }, [wheelNames]);

  const addName = () => {
    const n = newName.trim();
    if (!n || wheelNames.includes(n)) {
      setNewName("");
      return;
    }
    setWheelNames((prev) => [...prev, n]);
    seededRef.current = true; // an explicit edit means "this is my list now"
    setNewName("");
  };
  const removeName = (n: string) =>
    setWheelNames((prev) => prev.filter((x) => x !== n));

  return (
    <div className={`z-30 flex flex-col items-end gap-2 ${containerClassName}`}>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            className="flex max-h-[70vh] w-64 flex-col overflow-y-auto rounded-2xl border border-white/10 bg-[#1a1a22] p-3 shadow-xl"
          >
            {/* Sing & score */}
            <div className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              🎤 Sing &amp; score
            </div>
            <input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Your name"
              aria-label="Singer name"
              maxLength={20}
              className="mb-2 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-fuchsia-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => (mic.active ? mic.stop() : mic.start())}
              className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-left transition active:scale-95 ${
                mic.active
                  ? "bg-fuchsia-500 text-white"
                  : "bg-white/5 active:bg-white/10"
              }`}
            >
              <span className="text-2xl">🎤</span>
              <span className="flex-1 text-sm font-semibold">
                {mic.active ? "Singing…" : "Sing to score"}
              </span>
              {mic.active && (
                <span className="flex items-center gap-2">
                  <span className="relative h-6 w-1.5 overflow-hidden rounded-full bg-white/20">
                    <span
                      className="absolute bottom-0 left-0 w-full rounded-full bg-white"
                      style={{ height: `${Math.round(mic.level * 100)}%` }}
                    />
                  </span>
                  <span className="w-9 text-right text-sm font-bold tabular-nums">
                    {mic.note || "—"}
                  </span>
                </span>
              )}
            </button>
            {/* Show/hide the blue "target" pitch line on the TV (synced room-wide). */}
            <button
              type="button"
              aria-label={
                showTarget
                  ? "Hide the target pitch line on the TV"
                  : "Show the target pitch line on the TV"
              }
              onClick={onToggleTarget}
              className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2 transition active:scale-95"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className="h-2.5 w-2.5 rounded-full bg-[rgb(130,170,255)]" />
                Target line
              </span>
              <span
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                  showTarget ? "bg-fuchsia-500" : "bg-white/20"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                    showTarget ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </span>
            </button>
            {mic.error && (
              <p className="mt-1.5 px-1 text-xs font-medium text-red-400">
                {mic.error}
              </p>
            )}

            <div className="my-3 h-px shrink-0 bg-white/10" />

            {/* Random singer — an editable list (seeded from the queue) the
                wheel picks from, spun on the TV for everyone. */}
            <div className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              🎡 Random singer
            </div>
            {wheelNames.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {wheelNames.map((n) => (
                  <span
                    key={n}
                    className="flex items-center gap-1 rounded-full bg-white/10 py-1 pl-2.5 pr-1.5 text-xs"
                  >
                    <span className="max-w-[100px] truncate">{n}</span>
                    <button
                      type="button"
                      onClick={() => removeName(n)}
                      aria-label={`Remove ${n}`}
                      className="flex h-4 w-4 items-center justify-center rounded-full bg-white/10 text-[10px] leading-none text-white/70 active:scale-90"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="mb-2 flex gap-1.5">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addName();
                  }
                }}
                placeholder="Add a name"
                aria-label="Add a name to the wheel"
                maxLength={20}
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-fuchsia-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={addName}
                className="shrink-0 rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold active:scale-95"
              >
                Add
              </button>
            </div>
            <button
              type="button"
              onClick={() => onSpin(wheelNames)}
              disabled={wheelNames.length < 2}
              className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-500 to-pink-500 px-3 py-2.5 text-sm font-bold text-white transition active:scale-95 disabled:from-white/10 disabled:to-white/10 disabled:text-white/40"
            >
              🎡 {wheelNames.length < 2 ? "Add 2+ names to spin" : "Spin the wheel"}
            </button>

            <div className="my-3 h-px shrink-0 bg-white/10" />

            {/* Reactions */}
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              🎉 Reactions
            </div>
            {SFX_BUTTONS.map((b) => (
              <button
                key={b.name}
                type="button"
                onClick={() => onSfx(b.name)}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-left transition active:scale-95 active:bg-white/10"
              >
                <span className="text-2xl">{b.emoji}</span>
                <span className="text-sm font-medium">{b.label}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close menu" : "Sing & reactions"}
        className={`flex h-14 w-14 items-center justify-center rounded-full border border-white/10 text-2xl shadow-lg shadow-black/40 transition active:scale-95 ${
          mic.active && !open ? "bg-fuchsia-500 text-white" : "bg-[#1a1a22]"
        }`}
      >
        {open ? "✕" : "🎤"}
      </button>
    </div>
  );
}
