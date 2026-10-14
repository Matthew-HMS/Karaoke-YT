"use client";

// Client settings, persisted per-device in localStorage and shared live across
// every component that reads them (the Settings overlay writes; the Search tab
// and Lyrics panel react). Backed by a tiny external store so a toggle flipped
// in one place updates the others in the same tab immediately.
//
// KEY SAFETY: `orcaKey` is the USER'S OWN OrcaRouter key — it lives only on this
// device and is sent as the `x-orca-key` header on AI requests. The server
// default key is never stored here (the client can't see it); we only learn
// whether one exists via /api/ai/status.

import { useSyncExternalStore } from "react";

const KEYS = {
  orcaKey: "orca-key",
  orcaModel: "orca-model", // optional model override (only used with your own key)
  jpReading: "ai-jp-reading",
  romaji: "ai-romaji", // legacy boolean, migrated into jpReading
  smartCleanup: "ai-smart-cleanup",
  clientId: "ai-client-id", // per-device id for the free-use quota (guests)
} as const;

// Japanese reading aid shown on the lyrics: none, romaji under each line, or
// furigana (hiragana) above each kanji.
export type JpReading = "off" | "romaji" | "furigana";

// How this device is currently using AI (from /api/ai/status).
export type AiMode = "user" | "unlimited" | "free" | null;

type State = {
  orcaKey: string;
  orcaModel: string; // model override (empty = free default); used with own key
  jpReading: JpReading; // Japanese reading aid on lyrics (default off)
  smartCleanup: boolean; // LLM title cleanup for lyrics misses (default on)
  serverEnabled: boolean; // server has a default key (from /api/ai/status)
  freeLimit: number; // free AI uses on the shared key (from /api/ai/status)
  aiMode: AiMode; // how THIS device is using AI
  aiRemaining: number | null; // free uses left (only in "free" mode)
};

// A stable per-device id for the free-use quota (guests; signed-in users are
// keyed by account server-side). Generated once and kept in localStorage.
function readClientId(): string {
  try {
    let id = localStorage.getItem(KEYS.clientId);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEYS.clientId, id);
    }
    return id;
  } catch {
    return "anon";
  }
}

function readJpReading(): JpReading {
  const v = localStorage.getItem(KEYS.jpReading);
  if (v === "romaji" || v === "furigana" || v === "off") return v;
  // Migrate the old boolean romaji toggle, if present.
  return localStorage.getItem(KEYS.romaji) === "1" ? "romaji" : "off";
}

function read(): State {
  if (typeof window === "undefined") {
    return {
      orcaKey: "",
      orcaModel: "",
      jpReading: "off",
      smartCleanup: true,
      serverEnabled: false,
      freeLimit: 5,
      aiMode: null,
      aiRemaining: null,
    };
  }
  return {
    orcaKey: localStorage.getItem(KEYS.orcaKey) ?? "",
    orcaModel: localStorage.getItem(KEYS.orcaModel) ?? "",
    jpReading: readJpReading(),
    // Default ON: absent means "not set yet", so treat only an explicit "0" as off.
    smartCleanup: localStorage.getItem(KEYS.smartCleanup) !== "0",
    serverEnabled: false,
    freeLimit: 5,
    aiMode: null,
    aiRemaining: null,
  };
}

// Cached snapshot so useSyncExternalStore gets a stable reference between changes.
let snapshot: State = read();
const listeners = new Set<() => void>();

function emit() {
  snapshot = { ...snapshot };
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// AI status (server availability + this device's free-use remaining). Sends the
// device id + any user key so the server can report the right mode/remaining.
function fetchStatus() {
  if (typeof window === "undefined") return;
  const headers: Record<string, string> = { "x-ai-client": readClientId() };
  if (snapshot.orcaKey) headers["x-orca-key"] = snapshot.orcaKey;
  fetch("/api/ai/status", { headers })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      snapshot = {
        ...snapshot,
        serverEnabled: !!d.enabled,
        freeLimit: typeof d.freeLimit === "number" ? d.freeLimit : snapshot.freeLimit,
        aiMode: d.mode ?? null,
        aiRemaining: typeof d.remaining === "number" ? d.remaining : null,
      };
      for (const l of listeners) l();
    })
    .catch(() => {});
}

// Fetched once on first use; call refreshStatus() to re-check (e.g. after uses).
let statusFetched = false;
function ensureStatus() {
  if (statusFetched || typeof window === "undefined") return;
  statusFetched = true;
  fetchStatus();
}

export function refreshStatus() {
  fetchStatus();
}

export function setOrcaKey(v: string) {
  const key = v.trim();
  if (key) localStorage.setItem(KEYS.orcaKey, key);
  else localStorage.removeItem(KEYS.orcaKey);
  snapshot.orcaKey = key;
  emit();
  fetchStatus(); // mode/remaining depend on the key (own vs bypass vs free)
}

export function setOrcaModel(v: string) {
  const model = v.trim();
  if (model) localStorage.setItem(KEYS.orcaModel, model);
  else localStorage.removeItem(KEYS.orcaModel);
  snapshot.orcaModel = model;
  emit();
}

export function setJpReading(mode: JpReading) {
  localStorage.setItem(KEYS.jpReading, mode);
  localStorage.removeItem(KEYS.romaji); // supersedes the legacy toggle
  snapshot.jpReading = mode;
  emit();
}

export function setSmartCleanup(on: boolean) {
  localStorage.setItem(KEYS.smartCleanup, on ? "1" : "0");
  snapshot.smartCleanup = on;
  emit();
}

export type Settings = State & {
  // True when AI features should be offered at all: the server has a key OR the
  // user pasted their own.
  aiAvailable: boolean;
  // Headers to attach to AI requests — carries the user's own key when set.
  authHeaders: () => Record<string, string>;
  setOrcaKey: typeof setOrcaKey;
  setOrcaModel: typeof setOrcaModel;
  setJpReading: typeof setJpReading;
  setSmartCleanup: typeof setSmartCleanup;
  refreshStatus: typeof refreshStatus;
};

export function useSettings(): Settings {
  ensureStatus();
  const s = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return {
    ...s,
    aiAvailable: s.serverEnabled || !!s.orcaKey,
    // Headers for AI requests: the per-device id for the free-use quota (guests),
    // plus the user's own key when they set one.
    authHeaders: (): Record<string, string> => {
      const h: Record<string, string> = { "x-ai-client": readClientId() };
      if (s.orcaKey) h["x-orca-key"] = s.orcaKey;
      // Model override only matters (and is only honored) with your own key.
      if (s.orcaKey && s.orcaModel) h["x-orca-model"] = s.orcaModel;
      return h;
    },
    setOrcaKey,
    setOrcaModel,
    setJpReading,
    setSmartCleanup,
    refreshStatus,
  };
}
