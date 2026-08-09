"use client";

// First-run spotlight tour for the host (TV) screen. Steps point at real UI via
// `[data-tour="..."]` anchors; for each step we dim the whole screen except the
// target (a box-shadow "cutout") and float a bubble next to it with Next/Skip.
//
// State is not persisted here — the host page decides when to mount this and
// what to do on `onDone` (stamp the onboarded flag + last-seen version).

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

export type TourStep = {
  // CSS selector for the anchor element, e.g. '[data-tour="join"]'.
  selector: string;
  title: string;
  body: string;
  // Optional side effect run when this step becomes active — e.g. switch to the
  // Queue tab so its anchor is on screen. Must be idempotent.
  onEnter?: () => void;
};

type Props = {
  steps: TourStep[];
  onDone: () => void;
};

type Box = { top: number; left: number; width: number; height: number };

// Padding around the highlighted element, in px.
const PAD = 8;
// Gap between the target and the bubble, in px.
const GAP = 14;
const BUBBLE_MAX_W = 320;

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

export function HostTour({ steps, onDone }: Props) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);

  // `steps` is a stable module constant and `index` only changes on Next, so
  // `step` keeps a stable identity between the host page's frequent re-renders —
  // that's what keeps the tracking effect below from being torn down mid-step.
  const step = steps[index];

  // Keep the latest `onDone` in a ref so the tracking effect never lists it as a
  // dependency (the host recreates it every render). Update outside of render.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  // When a step becomes active, run its side effect (e.g. switch tabs so the
  // anchor exists) then bring the anchor on-screen. `step` has a stable identity
  // per index, so this fires once per step.
  useEffect(() => {
    if (!step) return;
    step.onEnter?.();
    const el = document.querySelector(step.selector) as HTMLElement | null;
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [step]);

  // Continuously track the anchor's position with a rAF loop, so the spotlight
  // stays glued through scrolling, resizing, layout shifts, and step changes.
  // The loop sustains itself and only re-subscribes on a real step change, so
  // unrelated host re-renders can't interrupt measurement. setState fires only
  // when the box actually moves.
  const boxRef = useRef<Box | null>(null);
  useEffect(() => {
    if (!step) return;
    let raf = 0;
    let missing = 0;
    const tick = () => {
      const el = document.querySelector(step.selector) as HTMLElement | null;
      if (el) {
        missing = 0;
        const r = el.getBoundingClientRect();
        const next: Box = {
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        };
        if (!sameBox(boxRef.current, next)) {
          boxRef.current = next;
          setBox(next);
        }
      } else if (++missing > 10) {
        // Anchor genuinely absent — skip past this step (or finish).
        if (index < steps.length - 1) setIndex((i) => i + 1);
        else onDoneRef.current();
        return; // stop this loop; the step change restarts it
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step, index, steps.length]);

  const next = () => {
    if (index < steps.length - 1) setIndex((i) => i + 1);
    else onDone();
  };

  if (!step || !box) {
    // Nothing to point at yet (measuring) — render an invisible click-blocker so
    // the app underneath doesn't flash as interactive mid-tour.
    return <div className="fixed inset-0 z-[60]" />;
  }

  const isLast = index === steps.length - 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Highlight box (padded around the anchor), clamped to the viewport.
  const hlTop = Math.max(0, box.top - PAD);
  const hlLeft = Math.max(0, box.left - PAD);
  const hlWidth = Math.min(vw - hlLeft, box.width + PAD * 2);
  const hlHeight = Math.min(vh - hlTop, box.height + PAD * 2);

  // Place the bubble below the anchor if it fits, else above, else (for a tall
  // anchor like the video stage that fills the screen) pin it to the bottom so
  // it's always visible and reachable.
  const EST_BUBBLE_H = 150;
  const spaceBelow = vh - (box.top + box.height);
  const spaceAbove = box.top;
  let bubbleTop: number | undefined;
  let bubbleBottom: number | undefined;
  if (spaceBelow >= EST_BUBBLE_H + GAP) {
    bubbleTop = box.top + box.height + GAP;
  } else if (spaceAbove >= EST_BUBBLE_H + GAP) {
    bubbleBottom = vh - box.top + GAP;
  } else {
    bubbleBottom = 24;
  }

  // Center the bubble on the anchor, clamped so it never leaves the screen.
  const centerX = box.left + box.width / 2;
  const bubbleLeft = Math.min(
    Math.max(8, centerX - BUBBLE_MAX_W / 2),
    Math.max(8, vw - BUBBLE_MAX_W - 8),
  );

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Click-blocker so the app underneath isn't interactive during the tour.
          Clicking the dim area does nothing; Skip is the way out. */}
      <div className="absolute inset-0" />

      {/* Spotlight cutout: this box shows the anchor through a giant shadow. */}
      <div
        className="pointer-events-none absolute rounded-xl ring-2 ring-fuchsia-400"
        style={{
          top: hlTop,
          left: hlLeft,
          width: hlWidth,
          height: hlHeight,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.7)",
        }}
      />

      {/* Step bubble. */}
      <AnimatePresence mode="wait">
        <motion.div
          key={index}
          initial={{ opacity: 0, y: 10, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.9 }}
          transition={{ duration: 0.15 }}
          className="absolute w-[min(320px,calc(100vw-24px))] rounded-2xl border border-white/10 bg-[#1a1a22] p-4 shadow-xl"
          style={{ top: bubbleTop, bottom: bubbleBottom, left: bubbleLeft }}
        >
          <div className="text-sm font-bold text-white">{step.title}</div>
          <p className="mt-1 text-sm leading-snug text-white/60">{step.body}</p>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs tabular-nums text-white/40">
              {index + 1} / {steps.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onDone}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white/50 transition hover:text-white active:scale-95"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={next}
                className="rounded-lg bg-gradient-to-r from-fuchsia-500 to-pink-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:brightness-110 active:scale-95"
              >
                {isLast ? "Done" : "Next"}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
