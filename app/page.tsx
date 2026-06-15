"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  generateClientCode,
  isValidCode,
  isValidPassword,
  normalizeCode,
  normalizePassword,
} from "@/lib/code";

export default function Landing() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");
  const [pw, setPw] = useState("");
  // Validate on click against the live input value (not just React state) so a
  // controlled-state desync can't strand the user. Buttons stay clickable —
  // a disabled button that won't fire is its own bug.
  const pwRef = useRef<HTMLInputElement>(null);
  const joinRef = useRef<HTMLInputElement>(null);
  const [pwHint, setPwHint] = useState(false);
  const [joinHint, setJoinHint] = useState(false);

  // Host picks a 4-char password; stash it for the host page to set on the room.
  const createRoom = () => {
    const val = normalizePassword(pwRef.current?.value ?? pw);
    if (!isValidPassword(val)) {
      setPwHint(true);
      pwRef.current?.focus();
      return;
    }
    const code = generateClientCode();
    sessionStorage.setItem(`host-pw-${code}`, val);
    router.push(`/host/${code}`);
  };
  const joinRoom = () => {
    const val = normalizeCode(joinRef.current?.value ?? joinCode);
    if (!isValidCode(val)) {
      setJoinHint(true);
      joinRef.current?.focus();
      return;
    }
    router.push(`/r/${val}`);
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="bg-gradient-to-r from-fuchsia-400 via-pink-400 to-amber-300 bg-clip-text text-6xl font-black tracking-tight text-transparent">
          SingAlong
        </h1>
        <p className="mt-3 text-lg text-white/60">
          Instant karaoke. Queue YouTube from your phone — no downloads, no
          waiting.
        </p>

        <div className="mt-10 space-y-3">
          <input
            ref={pwRef}
            value={pw}
            onChange={(e) => {
              setPw(normalizePassword(e.target.value));
              setPwHint(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && createRoom()}
            placeholder="SET A 4-CHAR PASSWORD"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={4}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-xl font-bold tracking-[0.3em] uppercase outline-none focus:border-fuchsia-400"
          />
          <button
            type="button"
            onClick={createRoom}
            className="w-full rounded-2xl bg-gradient-to-r from-fuchsia-500 to-pink-500 px-6 py-4 text-lg font-bold text-white shadow-lg shadow-fuchsia-500/20 transition hover:brightness-110 active:scale-[0.99]"
          >
            🎤 Start a room (host screen)
          </button>
          <p className={`text-xs ${pwHint ? "text-amber-400" : "text-white/40"}`}>
            {pwHint
              ? "Enter a 4-character password (letters or numbers)."
              : "Guests will need this password to join."}
          </p>
        </div>

        <div className="my-8 flex items-center gap-4 text-white/30">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-sm">or join one</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        <div className="space-y-3">
          <input
            ref={joinRef}
            value={joinCode}
            onChange={(e) => {
              setJoinCode(normalizeCode(e.target.value));
              setJoinHint(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && joinRoom()}
            placeholder="ENTER CODE"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={4}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-2xl font-bold tracking-[0.3em] uppercase outline-none focus:border-fuchsia-400"
          />
          <button
            type="button"
            onClick={joinRoom}
            className="w-full rounded-xl bg-white/10 py-3 font-semibold transition hover:bg-white/20"
          >
            Join
          </button>
          {joinHint && (
            <p className="text-xs text-amber-400">
              Enter the 4-character room code from the host screen.
            </p>
          )}
        </div>
        <p className="mt-4 text-sm text-white/40">
          The host screen shows a QR code — scan it, then enter the password.
        </p>
      </div>
    </main>
  );
}
