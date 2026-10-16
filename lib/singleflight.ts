// De-duplicate concurrent identical work in this process.
//
// Why the AI readings need it: the SAME song is requested simultaneously by
// every device showing the lyrics — the TV plus each phone in the room — and in
// dev React StrictMode double-invokes the fetching effect on top of that. The
// SQLite cache can't help, because it's only written once the first call
// FINISHES: until then every one of those requests is a cache miss and makes its
// own (billed) model call. Observed in the OrcaRouter console as three identical
// prompts a second apart for one song.
//
// Joining an in-flight call instead collapses them to one. Callers share the
// result — and the rejection, which is what we want: if the model call failed,
// it failed for all of them.
const inflight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = run();
  inflight.set(key, p);
  // Clear on settle so the next request starts fresh. Swallow here only to keep
  // the cleanup from raising an unhandled rejection; `p` itself still rejects
  // for every caller that awaited it.
  void p.catch(() => {}).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  return p;
}

// Stable short identity for a list of lyric lines, so a cached reading can be
// checked against the EXACT text it was generated for (line count alone isn't
// enough — a different lyrics match with the same number of lines would silently
// render the old readings over the new words). FNV-1a: tiny, dependency-free,
// and only ever compared against itself.
export function linesHash(lines: string[]): string {
  let h = 0x811c9dc5;
  const s = lines.join("\n");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
