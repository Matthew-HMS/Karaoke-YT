"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { generateClientCode, isValidCode, normalizeCode } from "@/lib/code";

export default function Landing() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");

  const createRoom = () => router.push(`/host/${generateClientCode()}`);
  const joinRoom = () => {
    if (isValidCode(joinCode)) router.push(`/r/${joinCode}`);
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

        <button
          onClick={createRoom}
          className="mt-10 w-full rounded-2xl bg-gradient-to-r from-fuchsia-500 to-pink-500 px-6 py-4 text-lg font-bold text-white shadow-lg shadow-fuchsia-500/20 transition hover:brightness-110 active:scale-[0.99]"
        >
          🎤 Start a room (host screen)
        </button>

        <div className="my-8 flex items-center gap-4 text-white/30">
          <div className="h-px flex-1 bg-white/10" />
          <span className="text-sm">or join one</span>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(normalizeCode(e.target.value))}
            onKeyDown={(e) => e.key === "Enter" && joinRoom()}
            placeholder="CODE"
            inputMode="text"
            autoCapitalize="characters"
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center text-2xl font-bold tracking-[0.3em] uppercase outline-none focus:border-fuchsia-400"
          />
          <button
            onClick={joinRoom}
            disabled={!isValidCode(joinCode)}
            className="rounded-xl bg-white/10 px-6 font-semibold transition hover:bg-white/20 disabled:opacity-30"
          >
            Join
          </button>
        </div>
        <p className="mt-4 text-sm text-white/40">
          The host screen shows a QR code — scan it to join from your phone.
        </p>
      </div>
    </main>
  );
}
