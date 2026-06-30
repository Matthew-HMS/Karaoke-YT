"use client";

// The "random singer" wheel — a full-screen overlay that spins and lands on a
// name. The spin (names + winner + turn count) is decided by the phone that
// tapped it and broadcast, so the TV and every phone render the SAME wheel and
// land together (see useRoom `spinWheel` / `wheel:spin`). Sound is opt-in via
// the callbacks, so only the host (TV) plays the drumroll/applause.

import { useEffect, useRef, useState } from "react";

export type WheelSpin = {
  names: string[];
  winner: number; // index into names
  turns: number; // shared whole spins, so all screens land in sync
  id: number; // bumps per spin so a repeat of the same result re-animates
};

const SPIN_MS = 4800; // how long the wheel decelerates
const HOLD_MS = 5000; // keep the winner banner up this long after it lands
// Slice colors: a bright rainbow so each name is easy to track as it spins.
const sliceColor = (i: number, n: number) => `hsl(${(i * 360) / n}, 68%, 55%)`;

// A point on the wheel rim at a clockwise angle from the top (12 o'clock).
function rimPoint(angleDeg: number, r = 49, cx = 50, cy = 50) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
}

export function SpinnerWheel({
  spin,
  onSpinStart,
  onLand,
}: {
  spin: WheelSpin | null;
  onSpinStart?: () => void;
  onLand?: () => void;
}) {
  const [active, setActive] = useState<WheelSpin | null>(null);
  const [rotation, setRotation] = useState(0);
  const [landed, setLanded] = useState(false);
  const rotationRef = useRef(0); // cumulative degrees, always spins forward
  const lastIdRef = useRef(0);
  // Three phases of one spin: a brief delay so the start frame paints, the
  // landing (when the wheel stops), and the auto-dismiss.
  const startTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const landTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clearTimers = () => {
    clearTimeout(startTimer.current);
    clearTimeout(landTimer.current);
    clearTimeout(hideTimer.current);
  };

  // Keep the sound callbacks fresh without re-running the spin effect (the
  // parent passes new inline fns each render).
  const cbRef = useRef({ onSpinStart, onLand });
  useEffect(() => {
    cbRef.current = { onSpinStart, onLand };
  });

  // Start a spin whenever a new one arrives.
  useEffect(() => {
    if (!spin || spin.id === lastIdRef.current) return;
    lastIdRef.current = spin.id;
    if (spin.names.length < 2) return;
    clearTimers();

    const n = spin.names.length;
    const seg = 360 / n;
    // Rotation (mod 360) that brings the winner's slice center under the top
    // pointer. Add `turns` whole spins on top of the current angle so it always
    // rotates forward into place.
    const desiredMod = (360 - ((spin.winner * seg + seg / 2) % 360)) % 360;
    const current = rotationRef.current;
    const currentMod = ((current % 360) + 360) % 360;
    const delta = (desiredMod - currentMod + 360) % 360;
    const total = current + spin.turns * 360 + delta;

    // Mount/hold the wheel at its CURRENT angle first; a CSS transition only
    // animates a *change* to an element already in the DOM, so if we jumped
    // straight to `total` on the same render the wheel would just appear already
    // landed (the "no animation" bug). Paint the start, THEN rotate to target.
    setActive(spin);
    setLanded(false);
    setRotation(current);
    cbRef.current.onSpinStart?.();

    startTimer.current = setTimeout(() => {
      rotationRef.current = total;
      setRotation(total); // now the transition runs
      landTimer.current = setTimeout(() => {
        setLanded(true);
        cbRef.current.onLand?.();
        hideTimer.current = setTimeout(() => setActive(null), HOLD_MS);
      }, SPIN_MS + 150);
    }, 60);
  }, [spin]);

  // Clean up pending timers on unmount.
  useEffect(() => () => clearTimers(), []);

  if (!active) return null;
  const { names, winner } = active;
  const n = names.length;
  const seg = 360 / n;

  const dismiss = () => {
    clearTimers();
    setActive(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-black/75 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div className="text-lg font-bold uppercase tracking-[0.3em] text-white/70">
        {landed ? "🎤 You're up!" : "Spinning…"}
      </div>

      <div className="relative aspect-square w-[min(82vw,460px)]">
        {/* Pointer at the top, fixed (the wheel turns under it). */}
        <div
          className="absolute left-1/2 top-[-6px] z-10 -translate-x-1/2"
          style={{
            width: 0,
            height: 0,
            borderLeft: "16px solid transparent",
            borderRight: "16px solid transparent",
            borderTop: "26px solid white",
            filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.5))",
          }}
        />
        {/* The wheel: a single element rotated with a CSS transition so the
            deceleration is buttery. Landing is driven by a timer (see effect),
            not transitionend, which wouldn't fire if no transition ran. */}
        <div
          className="h-full w-full"
          style={{
            transform: `rotate(${rotation}deg)`,
            transition: `transform ${SPIN_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <svg viewBox="0 0 100 100" className="h-full w-full drop-shadow-2xl">
            {names.map((name, i) => {
              const a0 = i * seg;
              const a1 = (i + 1) * seg;
              const p0 = rimPoint(a0);
              const p1 = rimPoint(a1);
              const large = seg > 180 ? 1 : 0;
              const mid = a0 + seg / 2;
              const label = rimPoint(mid, 30); // text anchor, mid-radius
              // Flip text on the bottom half so it isn't upside down.
              const flip = mid > 90 && mid < 270 ? 180 : 0;
              const display = name.length > 12 ? name.slice(0, 11) + "…" : name;
              return (
                <g key={i}>
                  <path
                    d={`M50,50 L${p0.x},${p0.y} A49,49 0 ${large} 1 ${p1.x},${p1.y} Z`}
                    fill={sliceColor(i, n)}
                    stroke="rgba(0,0,0,0.25)"
                    strokeWidth={0.4}
                  />
                  <text
                    x={label.x}
                    y={label.y}
                    fill="white"
                    fontSize={n > 8 ? 3.6 : 4.6}
                    fontWeight="700"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    transform={`rotate(${mid + flip}, ${label.x}, ${label.y})`}
                    style={{ paintOrder: "stroke" }}
                    stroke="rgba(0,0,0,0.35)"
                    strokeWidth={0.3}
                  >
                    {display}
                  </text>
                </g>
              );
            })}
            {/* Hub */}
            <circle cx="50" cy="50" r="6" fill="#1a1a22" stroke="white" strokeWidth={1.2} />
          </svg>
        </div>
      </div>

      {/* Winner callout (after it lands). */}
      <div className="h-12">
        {landed && (
          <div className="animate-pulse rounded-2xl bg-gradient-to-r from-fuchsia-500 to-pink-500 px-6 py-2.5 text-2xl font-black text-white shadow-xl">
            {names[winner]}
          </div>
        )}
      </div>
      <div className="text-xs text-white/40">tap anywhere to dismiss</div>
    </div>
  );
}
