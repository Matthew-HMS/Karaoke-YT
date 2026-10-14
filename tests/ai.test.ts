import { afterEach, describe, expect, it, vi } from "vitest";
import { parseQueries } from "@/lib/aiSuggest";
import { hasKana, alignRomaji } from "@/lib/romanize";
import { coerceFurigana } from "@/lib/furigana";
import {
  DEFAULT_MODEL,
  LlmBadKey,
  LlmFreeExhausted,
  LlmNoCredits,
  LlmRateLimited,
  LlmTimeout,
  listModels,
  llmJSON,
  resolveAccess,
} from "@/lib/llm";

describe("parseQueries (mood search)", () => {
  it("keeps clean query strings, trims and strips wrapping quotes", () => {
    expect(parseQueries(['  周杰伦 告白气球 ', '"Adele Hello"'])).toEqual([
      "周杰伦 告白气球",
      "Adele Hello",
    ]);
  });

  it("drops non-strings, blanks and case-insensitive duplicates", () => {
    expect(
      parseQueries(["Mayday 倔強", 42, "", null, "mayday 倔強", "  "])
    ).toEqual(["Mayday 倔強"]);
  });

  it("returns [] for non-array input", () => {
    expect(parseQueries("nope")).toEqual([]);
    expect(parseQueries(null)).toEqual([]);
  });

  it("caps the number of queries", () => {
    const many = Array.from({ length: 40 }, (_, i) => `song ${i}`);
    expect(parseQueries(many).length).toBeLessThanOrEqual(12);
  });
});

describe("hasKana (Japanese detection)", () => {
  it("is true when hiragana or katakana are present", () => {
    expect(hasKana("こんにちは")).toBe(true); // hiragana
    expect(hasKana("カラオケ")).toBe(true); // katakana
    expect(hasKana("夜に駆ける")).toBe(true); // kanji + kana
  });

  it("is false for kanji-only (ambiguous with Chinese) and Latin", () => {
    expect(hasKana("告白气球")).toBe(false); // Chinese, no kana
    expect(hasKana("Bohemian Rhapsody")).toBe(false);
  });
});

describe("alignRomaji", () => {
  it("forces the output to the requested length, padding with empty strings", () => {
    expect(alignRomaji(["yoru", "ni"], 3)).toEqual(["yoru", "ni", ""]);
    expect(alignRomaji(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });

  it("coerces non-strings and trims, and handles non-array input", () => {
    expect(alignRomaji(["  hi ", 5, null], 3)).toEqual(["hi", "", ""]);
    expect(alignRomaji("nope", 2)).toEqual(["", ""]);
  });
});

describe("resolveAccess (key + quota policy)", () => {
  const prevKey = process.env.ORCAROUTER_API_KEY;
  const prevSecret = process.env.AI_BYPASS_SECRET;
  const prevPaid = process.env.ORCAROUTER_PAID_KEY;
  afterEach(() => {
    process.env.ORCAROUTER_API_KEY = prevKey;
    process.env.AI_BYPASS_SECRET = prevSecret;
    if (prevPaid === undefined) delete process.env.ORCAROUTER_PAID_KEY;
    else process.env.ORCAROUTER_PAID_KEY = prevPaid;
  });

  it("uses the server key under the free quota when no user key is given", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    expect(resolveAccess(undefined)).toEqual({
      keys: ["sk-server"],
      mode: "free",
      model: DEFAULT_MODEL,
    });
    expect(resolveAccess("")).toEqual({ keys: ["sk-server"], mode: "free", model: DEFAULT_MODEL });
  });

  it("pools comma-separated server keys for failover", () => {
    process.env.ORCAROUTER_API_KEY = "sk-a, sk-b ,sk-c";
    expect(resolveAccess(undefined)).toEqual({
      keys: ["sk-a", "sk-b", "sk-c"],
      mode: "free",
      model: DEFAULT_MODEL,
    });
  });

  it("uses the caller's own key with no quota (mode=user)", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    expect(resolveAccess("sk-mine")).toEqual({
      keys: ["sk-mine"],
      mode: "user",
      model: DEFAULT_MODEL,
    });
  });

  it("honors a model override only for the caller's own key", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    // own key → override wins
    expect(resolveAccess("sk-mine", "deepseek/deepseek-v4-flash")).toEqual({
      keys: ["sk-mine"],
      mode: "user",
      model: "deepseek/deepseek-v4-flash",
    });
    // shared server key → override ignored (owner's credits protected)
    expect(resolveAccess(undefined, "deepseek/deepseek-v4-flash")).toEqual({
      keys: ["sk-server"],
      mode: "free",
      model: DEFAULT_MODEL,
    });
  });

  it("maps the bypass secret to the server key pool with no quota (mode=unlimited)", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    process.env.AI_BYPASS_SECRET = "imsho";
    expect(resolveAccess("imsho")).toEqual({
      keys: ["sk-server"],
      mode: "unlimited",
      model: DEFAULT_MODEL,
    });
  });

  it("ignores a model override for the bypass (owner stays on the free model)", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    process.env.AI_BYPASS_SECRET = "imsho";
    // The bypass is free-only on purpose — a requested model is NOT honored.
    expect(resolveAccess("imsho", "qwen/qwen3.7-flash")).toEqual({
      keys: ["sk-server"],
      mode: "unlimited",
      model: DEFAULT_MODEL,
    });
  });

  it("returns null for the bypass secret when there is no server key to use", () => {
    delete process.env.ORCAROUTER_API_KEY;
    process.env.AI_BYPASS_SECRET = "imsho";
    // The magic word isn't a real API key, so AI is simply off here.
    expect(resolveAccess("imsho")).toBeNull();
  });

  it("returns null when there is no key at all", () => {
    delete process.env.ORCAROUTER_API_KEY;
    expect(resolveAccess(undefined)).toBeNull();
  });

  it("attaches the paid fallback to FREE mode only — not the bypass, not a user's own key", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    process.env.AI_BYPASS_SECRET = "imsho";
    process.env.ORCAROUTER_PAID_KEY = "sk-paid-1, sk-paid-2";

    // free mode (guests): shared pool, paid key as the fallback behind it
    expect(resolveAccess(undefined)).toEqual({
      keys: ["sk-server"],
      mode: "free",
      model: DEFAULT_MODEL,
      fallback: { keys: ["sk-paid-1", "sk-paid-2"], model: "deepseek/deepseek-v4-flash" },
    });
    // owner bypass: free-only, so NO paid fallback (it must never spend)
    expect(resolveAccess("imsho")).toEqual({
      keys: ["sk-server"],
      mode: "unlimited",
      model: DEFAULT_MODEL,
    });
    // a user spending their own key does NOT get the owner's paid fallback
    expect(resolveAccess("sk-mine")?.fallback).toBeUndefined();
  });
});

describe("coerceFurigana", () => {
  it("keeps valid segments that reconstruct the line exactly", () => {
    const raw = [
      [
        { t: "何十回", r: "なんじゅっかい" },
        { t: "の" },
        { t: "夜", r: "よる" },
      ],
    ];
    expect(coerceFurigana(raw, ["何十回の夜"])).toEqual(raw);
  });

  it("falls back to a plain line when segments don't reconstruct it", () => {
    // Missing the final "を" → concatenation != original, so drop the furigana.
    const raw = [[{ t: "夜", r: "よる" }]];
    expect(coerceFurigana(raw, ["夜を"])).toEqual([[{ t: "夜を" }]]);
  });

  it("drops a stray reading on kana but keeps text intact via the guard", () => {
    // Bad segment shape still can't corrupt text: it only passes if t's rejoin.
    const raw = [[{ t: "カラオケ", r: "からおけ" }]];
    expect(coerceFurigana(raw, ["カラオケ"])).toEqual([
      [{ t: "カラオケ", r: "からおけ" }],
    ]);
  });

  it("always returns exactly one entry per input line", () => {
    expect(coerceFurigana([], ["あ", "い", "う"])).toEqual([
      [{ t: "あ" }],
      [{ t: "い" }],
      [{ t: "う" }],
    ]);
  });
});

describe("listModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the catalog's ids, sorted, dropping non-strings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async (): Promise<unknown> => ({
          data: [{ id: "qwen/qwen3.7-flash" }, { id: 42 }, { id: "deepseek/deepseek-v4-flash" }, {}],
        }),
      }))
    );
    expect(await listModels("sk-mine")).toEqual([
      "deepseek/deepseek-v4-flash",
      "qwen/qwen3.7-flash",
    ]);
  });

  it("throws LlmBadKey on a 403 (key can't list / is rejected)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 403, ok: false, text: async (): Promise<string> => "" }))
    );
    await expect(listModels("sk-bad")).rejects.toBeInstanceOf(LlmBadKey);
  });
});

describe("llmJSON (OrcaRouter client)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okResponse = (content: string) => ({
    status: 200,
    ok: true,
    json: async (): Promise<unknown> => ({ choices: [{ message: { content } }] }),
    text: async (): Promise<string> => "",
  });

  it("parses JSON returned inside a ```json fence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse('```json\n["a","b"]\n```'))
    );
    const out = await llmJSON<string[]>({
      keys: ["sk-test"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out).toEqual(["a", "b"]);
  });

  it("extracts a JSON object embedded in prose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse('Sure! {"artist":"Adele","track":"Hello"} done'))
    );
    const out = await llmJSON<{ artist: string; track: string }>({
      keys: ["sk-test"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out).toEqual({ artist: "Adele", track: "Hello" });
  });

  it("throws LlmRateLimited when every key stays 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 429,
        ok: false,
        text: async (): Promise<string> => "free_rate_limited",
      }))
    );
    await expect(
      llmJSON({ keys: ["sk-test"], messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(LlmRateLimited);
  });

  it("fails over to the next key when the first is 429", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer sk-a"
        ? { status: 429, ok: false, text: async (): Promise<string> => "free_rate_limited" }
        : okResponse('["ok"]');
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await llmJSON<string[]>({
      keys: ["sk-a", "sk-b"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out).toEqual(["ok"]);
    // First the exhausted key, then the working one — no backoff needed.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("fails over past a free-daily-exhausted (402) key to a working one", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer sk-a"
        ? {
            status: 402,
            ok: false,
            text: async (): Promise<string> =>
              '{"error":{"code":"free_quota_exhausted"}}',
          }
        : okResponse('["ok"]');
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await llmJSON<string[]>({
      keys: ["sk-a", "sk-b"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out).toEqual(["ok"]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("throws LlmFreeExhausted when all keys are daily-exhausted (402 free_quota_exhausted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 402,
        ok: false,
        text: async (): Promise<string> => '{"error":{"code":"free_quota_exhausted"}}',
      }))
    );
    await expect(
      llmJSON({ keys: ["sk-a", "sk-b"], messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(LlmFreeExhausted);
  });

  it.each([401, 403])("throws LlmBadKey on a %d (invalid key / wrong scope)", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status,
        ok: false,
        text: async (): Promise<string> => '{"error":{"code":"model_access_denied"}}',
      }))
    );
    await expect(
      llmJSON({ keys: ["sk-bad"], messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(LlmBadKey);
  });

  it("throws LlmNoCredits on a 402 for a paid model (out of credits)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 402,
        ok: false,
        text: async (): Promise<string> =>
          '{"error":{"message":"out of credits — needs $0.0002"}}',
      }))
    );
    await expect(
      llmJSON({ keys: ["sk-mine"], messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(LlmNoCredits);
  });

  it("throws LlmTimeout when the request aborts/times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error("The operation timed out");
        e.name = "TimeoutError";
        throw e;
      })
    );
    await expect(
      llmJSON({ keys: ["sk-test"], messages: [{ role: "user", content: "hi" }] })
    ).rejects.toBeInstanceOf(LlmTimeout);
  });

  it("sends the key as a Bearer token", async () => {
    const fetchMock = vi.fn(async () => okResponse("[]"));
    vi.stubGlobal("fetch", fetchMock);
    await llmJSON({ keys: ["sk-secret"], messages: [{ role: "user", content: "hi" }] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-secret"
    );
  });

  it("falls back to the paid key+model when the free pool is daily-exhausted", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      const model = JSON.parse(init.body as string).model;
      return auth === "Bearer sk-free"
        ? {
            status: 402,
            ok: false,
            text: async (): Promise<string> => '{"error":{"code":"free_quota_exhausted"}}',
          }
        : // paid key, called with the paid model → serves
          model === "deepseek-v4-flash"
          ? okResponse('["paid"]')
          : okResponse('["wrong-model"]');
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await llmJSON<string[]>({
      keys: ["sk-free"],
      messages: [{ role: "user", content: "hi" }],
      fallback: { keys: ["sk-paid"], model: "deepseek-v4-flash" },
    });
    expect(out).toEqual(["paid"]);
  });

  it("falls back to the paid key when the free pool stays rate-limited", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer sk-free"
        ? { status: 429, ok: false, text: async (): Promise<string> => "free_rate_limited" }
        : okResponse('["paid"]');
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await llmJSON<string[]>({
      keys: ["sk-free"],
      messages: [{ role: "user", content: "hi" }],
      fallback: { keys: ["sk-paid"], model: "deepseek-v4-flash" },
      // Own signal so the default 20s timeout isn't used; the only real waits are
      // the rate-limit backoffs (~4.5s), hence the widened test timeout below.
      signal: new AbortController().signal,
    });
    expect(out).toEqual(["paid"]);
  }, 10_000);

  it("surfaces the ORIGINAL free-tier error when the paid fallback also fails", async () => {
    // Free pool exhausted; paid key is out of credits → caller should see the
    // free-tier status (LlmFreeExhausted), not the owner's billing problem.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer sk-free"
        ? {
            status: 402,
            ok: false,
            text: async (): Promise<string> => '{"error":{"code":"free_quota_exhausted"}}',
          }
        : {
            status: 402,
            ok: false,
            text: async (): Promise<string> => '{"error":{"message":"out of credits"}}',
          };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      llmJSON({
        keys: ["sk-free"],
        messages: [{ role: "user", content: "hi" }],
        fallback: { keys: ["sk-paid"], model: "deepseek-v4-flash" },
      })
    ).rejects.toBeInstanceOf(LlmFreeExhausted);
  });
});
