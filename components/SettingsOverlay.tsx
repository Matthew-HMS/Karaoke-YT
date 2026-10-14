"use client";

// The ⚙ Settings overlay — one place that lists this device's settings. Holds
// the AI configuration (the user's OWN OrcaRouter key, optional) and the AI
// feature toggles (Japanese romaji, smart lyrics cleanup), plus the room's
// Target-line toggle (moved here from the floating quick menu). Styled like the
// other modals (WhatsNewModal). Reactions / Sing / Wheel stay in the quick menu.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useSettings } from "@/lib/useSettings";

// A labelled on/off switch matching the app's toggle style.
function Toggle({
  label,
  hint,
  swatch,
  on,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  swatch?: string; // optional colour dot before the label
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2.5 text-left transition active:scale-[0.98] disabled:opacity-40"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium">
          {swatch && (
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: swatch }}
            />
          )}
          {label}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-white/40">{hint}</span>}
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          on ? "bg-fuchsia-500" : "bg-white/20"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            on ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  // The room's Target-line toggle (synced room-wide via useRoom).
  showTarget: boolean;
  onToggleTarget: (v: boolean) => void;
  // Host only: replay the first-run guided tour (omitted on the remote).
  onReplayTour?: () => void;
};

export function SettingsOverlay({
  open,
  onClose,
  showTarget,
  onToggleTarget,
  onReplayTour,
}: Props) {
  const s = useSettings();
  // Local editing buffer for the key so typing doesn't fire a request per stroke;
  // committed on blur / save.
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const keyValue = keyDraft ?? s.orcaKey;
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const modelValue = modelDraft ?? s.orcaModel;
  // Model ids the user's own key can access (from OrcaRouter's live catalog) —
  // options for the Model dropdown. Empty until a key is set / the list loads.
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  // When true, show the free-text field instead of the dropdown (for a custom id).
  const [customModel, setCustomModel] = useState(false);

  // Refresh the free-use counter whenever the panel opens.
  useEffect(() => {
    if (open) s.refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load the models this key can access, to populate the Model picker. Fetched
  // live so the list stays current as OrcaRouter's catalog changes (no hardcoding);
  // the key is sent only to our server, which proxies /v1/models.
  useEffect(() => {
    setCustomModel(false);
    if (!open || !s.orcaKey) {
      setModels([]);
      setModelsLoading(false);
      return;
    }
    let active = true;
    setModelsLoading(true);
    fetch("/api/ai/models", { headers: s.authHeaders() })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d) => {
        if (active) setModels(Array.isArray(d?.models) ? (d.models as string[]) : []);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, s.orcaKey]);

  const commitModel = () => {
    if (modelDraft !== null) {
      s.setOrcaModel(modelDraft);
      setModelDraft(null);
    }
  };

  const commitKey = () => {
    if (keyDraft !== null) {
      s.setOrcaKey(keyDraft);
      setKeyDraft(null);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
          onClick={() => {
            commitKey();
            commitModel();
            onClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.85, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
            className="max-h-[85vh] w-[min(92%,440px)] overflow-y-auto rounded-3xl border border-white/10 bg-[#12121a] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-black">⚙ Settings</h2>
              <button
                type="button"
                onClick={() => {
                  commitKey();
                  commitModel();
                  onClose();
                }}
                aria-label="Close settings"
                className="rounded-full bg-white/10 px-3 py-1 text-sm active:scale-90"
              >
                Done
              </button>
            </div>

            {/* ---- AI ---- */}
            <div className="mt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">
                AI features
              </h3>

              <label className="mt-2 block text-sm font-medium">
                Your OrcaRouter key{" "}
                <span className="font-normal text-white/40">(optional)</span>
              </label>
              <input
                type="password"
                value={keyValue}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={commitKey}
                placeholder={
                  s.serverEnabled ? "Leave blank to use the room's free AI" : "Paste your key to enable AI"
                }
                autoComplete="off"
                className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm outline-none focus:border-fuchsia-400"
              />
              <p className="mt-1 text-xs text-white/40">
                Uses a free OrcaRouter model. Your key stays on this device.
              </p>

              {/* Live status: how this device is using AI right now. */}
              {s.aiMode === "user" && (
                <p className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
                  ✓ Using your own key — unlimited.
                </p>
              )}
              {s.aiMode === "unlimited" && (
                <p className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
                  ✓ Owner key active — unlimited.
                </p>
              )}
              {s.aiMode === "free" && s.aiRemaining !== null && (
                <p
                  className={`mt-2 rounded-lg px-3 py-1.5 text-xs font-medium ${
                    s.aiRemaining > 0
                      ? "bg-white/5 text-white/60"
                      : "bg-amber-500/10 text-amber-300"
                  }`}
                >
                  {s.aiRemaining > 0
                    ? `✨ ${s.aiRemaining} of ${s.freeLimit} free AI uses left on the shared key.`
                    : "Free AI uses used up — paste your own key below to keep going."}
                </p>
              )}

              <a
                href="https://www.orcarouter.ai/ref/ref_03cb4e9a6589bc80c66b"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-2.5 text-sm font-semibold text-fuchsia-200 transition hover:brightness-110 active:scale-95"
              >
                🔑 Get a free OrcaRouter key ↗
              </a>

              {/* Owner bypass (imsho): locked to the free model, no picker. */}
              {s.orcaKey && s.aiMode === "unlimited" && (
                <div className="mt-3">
                  <label className="block text-sm font-medium">Model</label>
                  <p className="mt-1 text-sm text-white/50">
                    Using the free model{" "}
                    <code className="text-white/70">orcarouter/free</code>. Paste your own
                    OrcaRouter key above to choose other models.
                  </p>
                </div>
              )}

              {/* Model picker — only with a pasted OWN key (mode="user"). The
                  dropdown is fetched live from the key's accessible models, with a
                  "Custom id…" escape hatch so a new/renamed id is never locked out. */}
              {s.orcaKey && s.aiMode !== "unlimited" && (
                <div className="mt-3">
                  <label className="block text-sm font-medium">
                    Model{" "}
                    <span className="font-normal text-white/40">(optional)</span>
                  </label>
                  {/* A visible dropdown of the models this key can access (fetched
                      live, so it never goes stale), with a "Custom id…" escape
                      hatch to the free-text field so a new/renamed id is never
                      locked out. Falls back to the text field if the list is empty. */}
                  {models.length > 0 &&
                  !customModel &&
                  (modelValue === "" || models.includes(modelValue)) ? (
                    <select
                      value={models.includes(modelValue) ? modelValue : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__custom__") {
                          setCustomModel(true);
                          return;
                        }
                        s.setOrcaModel(v);
                        setModelDraft(null);
                      }}
                      className="mt-1 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 py-2.5 text-sm text-white outline-none focus:border-fuchsia-400"
                    >
                      <option value="">Default (orcarouter/free)</option>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value="__custom__">✏️ Custom id…</option>
                    </select>
                  ) : (
                    <>
                      <input
                        type="text"
                        value={modelValue}
                        onChange={(e) => setModelDraft(e.target.value)}
                        onBlur={commitModel}
                        placeholder="orcarouter/free (default)"
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        className="mt-1 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm outline-none focus:border-fuchsia-400"
                      />
                      {models.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            s.setOrcaModel("");
                            setModelDraft(null);
                            setCustomModel(false);
                          }}
                          className="mt-1 text-xs text-fuchsia-300 underline"
                        >
                          ← Choose from the list instead
                        </button>
                      )}
                    </>
                  )}
                  <p className="mt-1 text-xs text-white/40">
                    {modelsLoading
                      ? "Loading the models this key can use… "
                      : models.length > 0
                        ? `${models.length} models available — pick one above. `
                        : "Couldn't load a model list for this key (it may be invalid) — type an id below. "}
                    Prefer a fast <code className="text-white/60">*-flash</code> model — reasoning
                    models (e.g. qwen3.5-flash) are slow and can time out. For stable access, add
                    credits to your key and use e.g. <code className="text-white/60">deepseek/deepseek-v4-flash</code> (~$0.0002/song).{" "}
                    <a
                      href="https://www.orcarouter.ai/models"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-fuchsia-300 underline"
                    >
                      Browse models ↗
                    </a>
                  </p>
                </div>
              )}

              {s.aiAvailable ? (
                <div className="mt-3 space-y-2">
                  <div className="rounded-xl bg-white/5 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">Japanese reading</span>
                      <div className="flex rounded-lg bg-black/30 p-0.5 text-xs font-semibold">
                        {(
                          [
                            ["off", "Off"],
                            ["furigana", "あ Furigana"],
                            ["romaji", "A Romaji"],
                          ] as const
                        ).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => s.setJpReading(mode)}
                            className={`rounded-md px-2.5 py-1 transition ${
                              s.jpReading === mode
                                ? "bg-fuchsia-500 text-white"
                                : "text-white/50 active:scale-95"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <span className="mt-1 block text-xs text-white/40">
                      Furigana shows hiragana above kanji; romaji shows it in Latin below.
                    </span>
                  </div>
                  <Toggle
                    label="Smart lyrics cleanup"
                    hint="Use AI to find lyrics for messy titles"
                    on={s.smartCleanup}
                    onChange={s.setSmartCleanup}
                  />
                </div>
              ) : (
                <p className="mt-3 rounded-xl bg-white/5 px-3 py-2.5 text-xs text-white/50">
                  Add a key above (or set one on the server) to enable romaji,
                  smart lyrics cleanup, and AI song search.
                </p>
              )}
            </div>

            {/* ---- Playback ---- */}
            <div className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">
                Playback
              </h3>
              <div className="mt-2">
                <Toggle
                  label="Target line"
                  hint="Blue pitch guide on the TV (whole room)"
                  swatch="rgb(130,170,255)"
                  on={showTarget}
                  onChange={onToggleTarget}
                />
              </div>
            </div>

            {/* ---- Help (host only) ---- */}
            {onReplayTour && (
              <div className="mt-6">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fuchsia-300">
                  Help
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    onReplayTour();
                    onClose();
                  }}
                  className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2.5 text-left transition active:scale-[0.98]"
                >
                  <span className="text-sm font-medium">Replay the guided tour</span>
                  <span aria-hidden className="text-white/40">
                    ↻
                  </span>
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
