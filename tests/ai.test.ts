import { afterEach, describe, expect, it, vi } from "vitest";
import { parseQueries } from "@/lib/aiSuggest";
import {
  aiJSONBatch,
  alignIndexed,
  chunk,
  indexedGaps,
  numberLines,
  repairIndexedGaps,
} from "@/lib/aiCall";
import { alignTranslation, alreadyInLang, translateLines } from "@/lib/translate";
import { toSimplified, toTraditional } from "@/lib/chineseScript";
import { isTranslateLang } from "@/lib/translateLangs";
import { hasKana, alignRomaji } from "@/lib/romanize";
import { applyRevisions, coerceFurigana, droppedLineIndexes, type RevisionLog } from "@/lib/furigana";
import { linesHash, singleFlight } from "@/lib/singleflight";
import {
  DEFAULT_MODEL,
  LlmBadKey,
  LlmBadReply,
  LlmError,
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

describe("chunk (long-song batching)", () => {
  it("splits into fixed-size batches; the last may be short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3], 5)).toEqual([[1, 2, 3]]); // shorter than one chunk
    expect(chunk([], 3)).toEqual([]);
  });
});

describe("aiJSONBatch (chunked song = one quota unit)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs each batch and returns results in order", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async (): Promise<unknown> => ({
        choices: [{ message: { content: JSON.stringify([`r${n++}`]) } }],
      }),
      text: async (): Promise<string> => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await aiJSONBatch<string[]>({
      access: { keys: ["sk-x"], mode: "user", model: "m" },
      clientId: "c",
      batches: [
        [{ role: "user", content: "a" }],
        [{ role: "user", content: "b" }],
      ],
    });
    expect(out).toEqual([["r0"], ["r1"]]);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("yields null for a failed chunk and keeps the ones that worked", async () => {
    // One bad reply used to sink the whole song, discarding the chunks that HAD
    // arrived — why a long song could fail outright while short ones were fine.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      const content = call === 1 ? '[["ok"]]' : '[[{"t":"x"'; // 2nd is truncated
      return {
        status: 200,
        ok: true,
        json: async (): Promise<unknown> => ({ choices: [{ message: { content } }] }),
        text: async (): Promise<string> => "",
        headers: new Headers(),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await aiJSONBatch<unknown>({
      access: { keys: ["sk-x"], mode: "user", model: "m" },
      clientId: "c",
      batches: [
        [{ role: "user", content: "a" }],
        [{ role: "user", content: "b" }],
      ],
    });
    expect(out[0]).toEqual([["ok"]]); // good chunk survives
    expect(out[1]).toBeNull(); // bad chunk degrades to a hole
  });

  it("throws when NO chunk could be fetched", async () => {
    // Nothing to show at all → the caller must surface an error, not an empty
    // reading, and no quota is spent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async (): Promise<unknown> => ({ choices: [{ message: { content: "not json" } }] }),
        text: async (): Promise<string> => "",
        headers: new Headers(),
      }))
    );
    await expect(
      aiJSONBatch<unknown>({
        access: { keys: ["sk-x"], mode: "user", model: "m" },
        clientId: "c",
        batches: [[{ role: "user", content: "a" }]],
      })
    ).rejects.toBeInstanceOf(LlmBadReply);
  });
});

describe("llmJSON — unreadable replies", () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (content: string) => ({
    status: 200,
    ok: true,
    json: async (): Promise<unknown> => ({ choices: [{ message: { content } }] }),
    text: async (): Promise<string> => "",
    headers: new Headers(),
  });

  it("re-asks when the JSON is truncated, and uses the retry that parses", async () => {
    // Measured against the real gateway: a truncated array arrives with
    // finish_reason "stop", and the SAME prompt parses on the next attempt.
    let call = 0;
    const fetchMock = vi.fn(async () => reply(++call === 1 ? '[{"t":"cut' : '["fine"]'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      llmJSON<string[]>({ keys: ["sk-x"], messages: [{ role: "user", content: "hi" }] })
    ).resolves.toEqual(["fine"]);
    expect(fetchMock.mock.calls.length).toBe(2); // one retry, no backoff needed
  });

  it("throws LlmBadReply (not a rate limit) when every attempt is junk", async () => {
    const fetchMock = vi.fn(async () => reply("Sorry, I cannot do that."));
    vi.stubGlobal("fetch", fetchMock);
    const err = await llmJSON({
      keys: ["sk-x"],
      messages: [{ role: "user", content: "hi" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmBadReply);
    expect(err).not.toBeInstanceOf(LlmRateLimited);
    expect(fetchMock.mock.calls.length).toBe(3); // initial + the two retry rounds
  });

  it("treats an empty reply as unreadable rather than fatal", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => reply(++call === 1 ? "" : '["recovered"]'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      llmJSON<string[]>({ keys: ["sk-x"], messages: [{ role: "user", content: "hi" }] })
    ).resolves.toEqual(["recovered"]);
  });
});

describe("translation helpers", () => {
  it("isTranslateLang accepts known codes, rejects others", () => {
    expect(isTranslateLang("en")).toBe(true);
    expect(isTranslateLang("zh-Hant")).toBe(true);
    expect(isTranslateLang("xx")).toBe(false);
    expect(isTranslateLang(null)).toBe(false);
  });

  it("alignTranslation forces length and coerces like alignRomaji", () => {
    expect(alignTranslation([" hi ", 5, null], 3)).toEqual(["hi", "", ""]);
    expect(alignTranslation(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });

  it("alreadyInLang skips only when script reliably matches the target", () => {
    // Japanese target: kana present ⇒ already Japanese
    expect(alreadyInLang(["夜に駆ける"], "ja")).toBe(true);
    // Chinese target: Han with no kana/hangul ⇒ already Chinese
    expect(alreadyInLang(["告白气球"], "zh")).toBe(true);
    // Chinese target but kana present ⇒ Japanese, so NOT already Chinese → translate
    expect(alreadyInLang(["夜に駆ける"], "zh")).toBe(false);
    // Korean target
    expect(alreadyInLang(["안녕하세요"], "ko")).toBe(true);
    // Latin-script targets: never auto-skip (can't tell apart by script)
    expect(alreadyInLang(["Hello world"], "en")).toBe(false);
    expect(alreadyInLang(["Hola mundo"], "es")).toBe(false);
  });

  it("converts Chinese script by dictionary, leaving other text alone", () => {
    expect(toTraditional("我们的爱情 love")).toBe("我們的愛情 love");
    expect(toSimplified("告白氣球")).toBe("告白气球");
  });

  it("a Chinese song in the other script is converted without a model call", async () => {
    // `access` is never touched: the script conversion runs before any AI path.
    const opts = { access: null as never, clientId: "t" };
    expect(await translateLines("v", ["告白气球", ""], "zh-Hant", opts)).toEqual(["告白氣球", ""]);
    expect(await translateLines("v", ["告白氣球"], "zh", opts)).toEqual(["告白气球"]);
    // already in the chosen script → nothing to show
    expect(await translateLines("v", ["告白氣球"], "zh-Hant", opts)).toBeNull();
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

describe("indexed replies (which line is this an answer for?)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("numbers the lines it sends", () => {
    expect(numberLines(["夜に", "", "朝"])).toEqual(["0|夜に", "1|", "2|朝"]);
  });

  it("places each answer by its own index, not its position", () => {
    // The model merged lines 1 and 2 into one answer and tagged it "1".
    // Positionally that used to shift lines 2 and 3 onto the wrong text; now
    // line 2 is simply blank and everything after it stays correct.
    const raw = ["0|first", "1|second and third", "3|fourth"];
    expect(alignIndexed(raw, 4)).toEqual(["first", "second and third", "", "fourth"]);
  });

  it("ignores out-of-range indexes and keeps the first answer for a line", () => {
    expect(alignIndexed(["9|nope", "0|good", "0|later"], 2)).toEqual(["good", ""]);
  });

  it("falls back to positional when the model ignored the protocol", () => {
    // Untagged replies must behave exactly as before — never worse than the old
    // code just because a rule was dropped.
    expect(alignIndexed([" a ", "b"], 3)).toEqual(["a", "b", ""]);
    expect(alignIndexed("nope", 2)).toEqual(["", ""]);
  });

  it("finds the lines nobody answered for, ignoring blanks, up to a cap", () => {
    const lines = ["一", "", "二", "三"];
    expect(indexedGaps(["x", "", "", ""], lines, 9)).toEqual([2, 3]);
    expect(indexedGaps(["x", "", "", ""], lines, 1)).toEqual([2]);
    expect(indexedGaps(["x", "", "y", "z"], lines, 9)).toEqual([]);
  });

  it("repairs the gaps and leaves everything else alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async (): Promise<unknown> => ({
          choices: [{ message: { content: '["0|second","1|third"]' } }],
        }),
        text: async (): Promise<string> => "",
      }))
    );
    const out = await repairIndexedGaps({
      access: { keys: ["sk-test"], mode: "user", model: "m" },
      system: "sys",
      answers: ["first", "", ""],
      lines: ["一", "二", "三"],
    });
    expect(out).toEqual(["first", "second", "third"]);
  });

  it("keeps what it has when the repair call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 401, ok: false, text: async (): Promise<string> => "" }))
    );
    const answers = ["first", "", "third"];
    await expect(
      repairIndexedGaps({
        access: { keys: ["sk-test"], mode: "user", model: "m" },
        system: "sys",
        answers,
        lines: ["一", "二", "三"],
      })
    ).resolves.toEqual(answers);
  });

  it("makes no call when there is nothing to repair", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await repairIndexedGaps({
      access: { keys: ["sk-test"], mode: "user", model: "m" },
      system: "sys",
      answers: ["a", "b"],
      lines: ["一", "二"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
    delete process.env.ORCAROUTER_PAID_KEY;
    // Their key, no quota — plus a paid-model fallback on that same key. It needs
    // no ORCAROUTER_PAID_KEY: the fallback spends THEIR credits, so it's offered
    // whether or not the deployer configured a paid key of their own.
    expect(resolveAccess("sk-mine")).toEqual({
      keys: ["sk-mine"],
      mode: "user",
      model: DEFAULT_MODEL,
      fallback: { keys: ["sk-mine"], model: "deepseek/deepseek-v4-flash", own: true },
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

  it("gives both shared-key modes the owner's paid fallback", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    process.env.AI_BYPASS_SECRET = "imsho";
    process.env.ORCAROUTER_PAID_KEY = "sk-paid-1, sk-paid-2";
    const paid = { keys: ["sk-paid-1", "sk-paid-2"], model: "deepseek/deepseek-v4-flash" };

    // free mode (guests): shared pool, paid key as the fallback behind it
    expect(resolveAccess(undefined)).toEqual({
      keys: ["sk-server"],
      mode: "free",
      model: DEFAULT_MODEL,
      fallback: paid,
    });
    // owner bypass: same net. The free model's cooldown is global and hours long,
    // so without this the deployer's own credited key sat unused while AI failed.
    expect(resolveAccess("imsho")).toEqual({
      keys: ["sk-server"],
      mode: "unlimited",
      model: DEFAULT_MODEL,
      fallback: paid,
    });
  });

  it("falls a user's own key back to the paid model — on their key, not the owner's", () => {
    process.env.ORCAROUTER_API_KEY = "sk-server";
    process.env.ORCAROUTER_PAID_KEY = "sk-paid";

    // No model picked → free default, with THEIR key behind it (`own: true`), so
    // a free-pool cooldown doesn't dead-end a key that could have paid its way.
    expect(resolveAccess("sk-mine")).toEqual({
      keys: ["sk-mine"],
      mode: "user",
      model: DEFAULT_MODEL,
      fallback: { keys: ["sk-mine"], model: "deepseek/deepseek-v4-flash", own: true },
    });
    // The owner's paid key is never offered to a user's request.
    expect(resolveAccess("sk-mine")?.fallback?.keys).toEqual(["sk-mine"]);
    // A model they picked is honored as the PRIMARY attempt — but it still gets
    // the paid fallback, because any free id dead-ends once its daily cap is
    // spent (429 in milliseconds, credits never consulted).
    expect(resolveAccess("sk-mine", "orcarouter/free")).toEqual({
      keys: ["sk-mine"],
      mode: "user",
      model: "orcarouter/free",
      fallback: { keys: ["sk-mine"], model: "deepseek/deepseek-v4-flash", own: true },
    });
    // Unless the pick already IS the paid model — nothing left to fall back to.
    expect(resolveAccess("sk-mine", "deepseek/deepseek-v4-flash")).toEqual({
      keys: ["sk-mine"],
      mode: "user",
      model: "deepseek/deepseek-v4-flash",
    });
  });
});

describe("singleFlight (one model call per song, not one per viewer)", () => {
  it("shares one in-flight run across concurrent callers with the same key", async () => {
    let runs = 0;
    const run = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return "result";
    };
    // The TV and two phones asking for the same song at the same moment.
    const all = await Promise.all([
      singleFlight("song-a", run),
      singleFlight("song-a", run),
      singleFlight("song-a", run),
    ]);
    expect(all).toEqual(["result", "result", "result"]);
    expect(runs).toBe(1); // one billed model call, not three
  });

  it("does not share across different keys, and starts fresh after settling", async () => {
    let runs = 0;
    const run = async () => {
      runs++;
      return runs;
    };
    await Promise.all([singleFlight("a", run), singleFlight("b", run)]);
    expect(runs).toBe(2); // different songs → separate calls
    await singleFlight("a", run);
    expect(runs).toBe(3); // the earlier "a" settled, so this is a new call
  });

  it("gives every joiner the same rejection, then clears the slot", async () => {
    let runs = 0;
    const boom = async () => {
      runs++;
      throw new Error("model failed");
    };
    const results = await Promise.allSettled([
      singleFlight("x", boom),
      singleFlight("x", boom),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(runs).toBe(1);
    await expect(singleFlight("x", async () => "ok")).resolves.toBe("ok");
  });
});

describe("linesHash (bind a cached reading to its exact lyrics)", () => {
  it("differs when the text differs but the line COUNT matches", () => {
    // The case the old cache missed: same videoId, same number of lines, but a
    // different lyrics match — it served the old readings over the new words.
    const a = ["君の声が聞こえる", "星が降る街で"];
    const b = ["君の声が聞こえた", "星が降る街へ"];
    expect(a.length).toBe(b.length);
    expect(linesHash(a)).not.toBe(linesHash(b));
  });

  it("is stable for identical input", () => {
    const lines = ["何十回の夜を越えて", "明日を信じて"];
    expect(linesHash(lines)).toBe(linesHash([...lines]));
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

  it("splits an element that swallowed two lines back onto both", () => {
    // The model glues short lines together. Read positionally that shifted
    // every later line onto someone else's reading, and the guard then blanked
    // the whole chunk.
    const raw = [
      [
        { t: "君", r: "きみ" },
        { t: "が" },
        { t: "僕", r: "ぼく" },
        { t: "に" },
        { t: "見", r: "み" },
        { t: "せてくれた" },
      ],
    ];
    expect(coerceFurigana(raw, ["君が僕に", "見せてくれた"])).toEqual([
      [{ t: "君", r: "きみ" }, { t: "が" }, { t: "僕", r: "ぼく" }, { t: "に" }],
      [{ t: "見", r: "み" }, { t: "せてくれた" }],
    ]);
  });

  it("splits a merge that falls inside a plain segment", () => {
    expect(coerceFurigana([[{ t: "ないよまるで" }]], ["ないよ", "まるで"])).toEqual([
      [{ t: "ないよ" }],
      [{ t: "まるで" }],
    ]);
  });

  it("never splits a kanji run — one reading can't cover two lines", () => {
    // "記念" + "日" would need the reading halved, so both lines stay plain.
    const raw = [[{ t: "記念日", r: "きねんび" }]];
    expect(coerceFurigana(raw, ["記念", "日"])).toEqual([
      [{ t: "記念" }],
      [{ t: "日" }],
    ]);
  });

  it("keeps blank lines plain without consuming an element", () => {
    // A lyric sheet's verse breaks have nothing to read, and the model answers
    // 30 lines with 29 elements by quietly dropping them.
    const raw = [
      [{ t: "今日", r: "きょう" }, { t: "は" }, { t: "記念日", r: "きねんび" }],
      [{ t: "明日", r: "あした" }, { t: "も" }],
    ];
    expect(coerceFurigana(raw, ["今日は記念日", "", "明日も"])).toEqual([
      [{ t: "今日", r: "きょう" }, { t: "は" }, { t: "記念日", r: "きねんび" }],
      [{ t: "" }],
      [{ t: "明日", r: "あした" }, { t: "も" }],
    ]);
  });

  it("restores a space the model normalised away", () => {
    // Spacing comes from the LINE, readings from the model; a swallowed space
    // used to throw away an otherwise perfect reading.
    const raw = [[{ t: "「ありがとう」と" }, { t: "言", r: "い" }, { t: "えた" }]];
    expect(coerceFurigana(raw, ["「ありがとう」 と言えた"])).toEqual([
      [{ t: "「ありがとう」 と" }, { t: "言", r: "い" }, { t: "えた" }],
    ]);
  });

  it("refuses to put a space inside a ruby base", () => {
    // The annotation would be drawn across the gap; plain text is the safe answer.
    expect(coerceFurigana([[{ t: "君だ", r: "きみだ" }]], ["君 だ"])).toEqual([
      [{ t: "君 だ" }],
    ]);
  });

  it("resyncs past an element that fits no line", () => {
    const raw = [
      [{ t: "まったく違う" }],
      [{ t: "今日", r: "きょう" }, { t: "は" }, { t: "記念日", r: "きねんび" }],
      [{ t: "明日", r: "あした" }, { t: "も" }],
    ];
    expect(coerceFurigana(raw, ["今日は記念日", "明日も"])).toEqual([
      [{ t: "今日", r: "きょう" }, { t: "は" }, { t: "記念日", r: "きねんび" }],
      [{ t: "明日", r: "あした" }, { t: "も" }],
    ]);
  });

  it("costs ONE line when a line's reading never came back", () => {
    // The model skipped line 0. Positionally, line 1's reading landed on line 0
    // (guard-rejected) and line 1 went plain too — two losses from one. Now
    // line 1 keeps its own reading.
    const raw = [[{ t: "明日", r: "あした" }, { t: "も" }]];
    expect(coerceFurigana(raw, ["今日は記念日", "明日も"])).toEqual([
      [{ t: "今日は記念日" }],
      [{ t: "明日", r: "あした" }, { t: "も" }],
    ]);
  });
});

describe("droppedLineIndexes (lines the guard silently blanked)", () => {
  const annotated = [{ t: "何十回", r: "なんじゅっかい" }, { t: "の夜" }];

  it("finds a kanji line returned as the bare original", () => {
    // The guard rejected the model's segments, so this line renders with no
    // furigana at all — a 200 response that quietly lost its reading.
    const lines = ["今日は記念日", "カラオケ"];
    const furi = [[{ t: "今日は記念日" }], [{ t: "カラオケ" }]];
    expect(droppedLineIndexes(furi, lines)).toEqual([0]);
  });

  it("ignores kana-only lines — plain is correct for them", () => {
    const lines = ["カラオケ", "ありがとう"];
    const furi = [[{ t: "カラオケ" }], [{ t: "ありがとう" }]];
    expect(droppedLineIndexes(furi, lines)).toEqual([]);
  });

  it("ignores lines that did get a reading", () => {
    expect(droppedLineIndexes([annotated], ["何十回の夜"])).toEqual([]);
  });

  it("treats 々 as kanji and survives a short furigana array", () => {
    expect(droppedLineIndexes([[{ t: "日々" }]], ["日々"])).toEqual([0]);
    expect(droppedLineIndexes([], ["今日"])).toEqual([]); // no row → nothing to repair
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

  it("keeps a short reply when the time budget runs out", async () => {
    // The budget covers every attempt, so the LAST re-ask is the one that gets
    // cut off. Throwing then discarded a reply we already held and lost a whole
    // chunk of a song for nothing.
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      call++;
      if (call === 1) return okResponse('["a","b"]'); // short of `expect`
      // A slow upstream: hang until the caller's signal gives up.
      return await new Promise<never>((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await llmJSON<string[]>({
      keys: ["sk-test"],
      messages: [{ role: "user", content: "hi" }],
      expect: 3,
      signal: AbortSignal.timeout(80),
    });
    expect(out).toEqual(["a", "b"]);
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

  it("marks the error when the OWNER's paid fallback also failed", async () => {
    // Same as above, but assert the breadcrumb routes use to say "the backup is
    // down too" — the caller still sees the free-tier error, not the billing one.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === "Bearer sk-free"
        ? {
            status: 402,
            ok: false,
            text: async (): Promise<string> => '{"error":{"code":"free_quota_exhausted"}}',
          }
        : { status: 401, ok: false, text: async (): Promise<string> => "bad paid key" };
    });
    vi.stubGlobal("fetch", fetchMock);
    const err = await llmJSON({
      keys: ["sk-free"],
      messages: [{ role: "user", content: "hi" }],
      fallback: { keys: ["sk-paid"], model: "deepseek-v4-flash" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmFreeExhausted);
    expect((err as LlmError).fallbackFailed).toBeTruthy();
  });

  it("surfaces the fallback's OWN error when it spent the caller's key", async () => {
    // `own: true` → the fallback is the user's key, so "no credits" is theirs to
    // act on; hiding it behind the free-tier status would be misleading.
    const fetchMock = vi.fn(async () => ({
      status: 402,
      ok: false,
      text: async (): Promise<string> => '{"error":{"message":"out of credits"}}',
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      llmJSON({
        keys: ["sk-mine"],
        messages: [{ role: "user", content: "hi" }],
        fallback: { keys: ["sk-mine"], model: "deepseek-v4-flash", own: true },
      })
    ).rejects.toBeInstanceOf(LlmNoCredits);
  });

  it("skips the backoff rounds when the 429 reports a cooldown of hours", async () => {
    // A saturated free pool reports retry_after_seconds in the thousands. Backing
    // off 1.5s + 3s cannot clear that, so we must fail fast and carry the number.
    const fetchMock = vi.fn(async () => ({
      status: 429,
      ok: false,
      headers: new Headers({ "retry-after": "19084" }),
      text: async (): Promise<string> =>
        '{"error":{"code":"free_rate_limited","metadata":{"retry_after_seconds":19084}}}',
    }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await llmJSON({
      keys: ["sk-free"],
      messages: [{ role: "user", content: "hi" }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRateLimited);
    expect((err as LlmRateLimited).retryAfterSeconds).toBe(19084);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one try, no pointless rounds
  });
});

describe("applyRevisions (AI corrects the dictionary, never undercuts it)", () => {
  const lines = ["そんな日々もどこか愛おしくて", "君が僕に見せてくれた"];
  // What the dictionary produced: 愛 is wrong (あい, should be いと).
  const base = [
    [
      { t: "そんな" },
      { t: "日々", r: "ひび" },
      { t: "もどこか" },
      { t: "愛", r: "あい" },
      { t: "おしくて" },
    ],
    [
      { t: "君", r: "きみ" },
      { t: "が" },
      { t: "僕", r: "ぼく" },
      { t: "に" },
      { t: "見", r: "み" },
      { t: "せてくれた" },
    ],
  ];

  it("applies a correction and leaves every other line alone", () => {
    const out = applyRevisions(base, lines, [
      {
        i: 0,
        segs: [
          { t: "そんな" },
          { t: "日々", r: "ひび" },
          { t: "もどこか" },
          { t: "愛", r: "いと" },
          { t: "おしくて" },
        ],
      },
    ]);
    expect(out[0].find((s) => s.t === "愛")?.r).toBe("いと");
    expect(out[1]).toEqual(base[1]);
  });

  it("rejects a correction that does not reconstruct the line", () => {
    const out = applyRevisions(base, lines, [
      { i: 0, segs: [{ t: "まったく違う行", r: "ちがう" }] },
    ]);
    expect(out[0]).toEqual(base[0]);
  });

  // The whole point of correcting rather than regenerating: the model cannot
  // hand back a line with fewer readings than the dictionary already had.
  it("rejects a correction that would lose coverage", () => {
    const out = applyRevisions(base, lines, [
      {
        i: 1,
        segs: [
          { t: "君", r: "きみ" },
          { t: "が僕に見せてくれた" }, // dropped 僕 and 見
        ],
      },
    ]);
    expect(out[1]).toEqual(base[1]);
  });

  it("accepts a correction that adds a reading to a bare line", () => {
    const bareLines = ["夜露死苦"];
    const bare = [[{ t: "夜露死苦" }]];
    const out = applyRevisions(bare, bareLines, [
      { i: 0, segs: [{ t: "夜露死苦", r: "よろしく" }] },
    ]);
    expect(out[0]).toEqual([{ t: "夜露死苦", r: "よろしく" }]);
  });

  it("ignores junk, bad indexes and readings on kana", () => {
    expect(applyRevisions(base, lines, null)).toEqual(base);
    expect(applyRevisions(base, lines, "nope")).toEqual(base);
    expect(applyRevisions(base, lines, [{ i: 99, segs: [{ t: "x" }] }])).toEqual(base);
    expect(applyRevisions(base, lines, [{ i: 1.5, segs: [{ t: "x" }] }])).toEqual(base);
    // a reading on kana, and a latin "reading" — both refused
    expect(
      applyRevisions(base, lines, [
        { i: 1, segs: [{ t: "君", r: "きみ" }, { t: "が", r: "ga" }, { t: "僕に見せてくれた" }] },
      ])
    ).toEqual(base);
  });
});

describe("applyRevisions rejects malformed corrections seen from a live model", () => {
  // Both of these were returned by the free model on a real song: they
  // reconstruct the line and keep coverage, so only a targeted check stops them.
  it("refuses ruby over a run that contains kana", () => {
    const lines = ["一番星を掻き消すような"];
    const base = [
      [{ t: "一番", r: "いちばん" }, { t: "星", r: "ほし" }, { t: "を" }, { t: "掻", r: "か" }, { t: "き" }, { t: "消", r: "け" }, { t: "すような" }],
    ];
    const out = applyRevisions(base, lines, [
      { i: 0, segs: [{ t: "一番星", r: "いちばんぼし" }, { t: "を掻き消すような", r: "をかきけすような" }] },
    ]);
    expect(out[0]).toEqual(base[0]); // the whole correction is refused
  });

  it("drops a reading that swallowed the kana in front of it, keeping the good fix beside it", () => {
    const lines = ["今日は一日中雨だった"];
    const base = [
      [{ t: "今日", r: "きょう" }, { t: "は" }, { t: "一日中", r: "いちにちじゅう" }, { t: "雨", r: "う" }, { t: "だった" }],
    ];
    const out = applyRevisions(base, lines, [
      { i: 0, segs: [{ t: "今日", r: "きょう" }, { t: "は" }, { t: "一日中", r: "はいちにちじゅう" }, { t: "雨", r: "あめ" }, { t: "だった" }] },
    ]);
    // は… refused, so 一日中 keeps the dictionary reading…
    expect(out[0].find((s) => s.t === "一日中")?.r).toBe("いちにちじゅう");
    // …while the genuine 雨 correction in the same reply still lands.
    expect(out[0].find((s) => s.t === "雨")?.r).toBe("あめ");
  });

  it("still accepts a genuine rendaku fix that regroups a compound", () => {
    const lines = ["一番星を見た"];
    const base = [[{ t: "一番", r: "いちばん" }, { t: "星", r: "ほし" }, { t: "を" }, { t: "見", r: "み" }, { t: "た" }]];
    const out = applyRevisions(base, lines, [
      { i: 0, segs: [{ t: "一番星", r: "いちばんぼし" }, { t: "を" }, { t: "見", r: "み" }, { t: "た" }] },
    ]);
    expect(out[0][0]).toEqual({ t: "一番星", r: "いちばんぼし" });
  });
});

describe("aiJSONBatch parallel mode (opt-in)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (body: unknown, status = 200) => ({
    status,
    ok: status < 400,
    json: async (): Promise<unknown> => body,
    text: async (): Promise<string> => JSON.stringify(body),
  });

  it("keeps results in batch order even when the later chunk answers first", async () => {
    // Chunk 0 is slow, chunk 1 is instant: sequential order must still hold.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const slow = String(init.body).includes("slow");
      if (slow) await new Promise((r) => setTimeout(r, 40));
      return reply({ choices: [{ message: { content: JSON.stringify([slow ? "first" : "second"]) } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await aiJSONBatch<string[]>({
      access: { keys: ["sk-x"], mode: "user", model: "m" },
      clientId: "c",
      batches: [[{ role: "user", content: "slow" }], [{ role: "user", content: "fast" }]],
      parallel: true,
    });
    expect(out).toEqual([["first"], ["second"]]);
  });

  it("actually overlaps the calls", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return reply({ choices: [{ message: { content: JSON.stringify(["x"]) } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await aiJSONBatch<string[]>({
      access: { keys: ["sk-x"], mode: "user", model: "m" },
      clientId: "c",
      batches: [
        [{ role: "user", content: "a" }],
        [{ role: "user", content: "b" }],
        [{ role: "user", content: "c" }],
      ],
      parallel: true,
    });
    expect(peak).toBe(3); // sequential would never exceed 1
  });

  it("nulls a failed chunk and keeps the rest, like the sequential path", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      String(init.body).includes("bad")
        ? reply({ error: { message: "nope" } }, 500)
        : reply({ choices: [{ message: { content: JSON.stringify(["ok"]) } }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await aiJSONBatch<string[]>({
      access: { keys: ["sk-x"], mode: "user", model: "m" },
      clientId: "c",
      batches: [[{ role: "user", content: "good" }], [{ role: "user", content: "bad" }]],
      parallel: true,
    });
    expect(out[0]).toEqual(["ok"]);
    expect(out[1]).toBeNull();
  });

  it("throws when every chunk fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: { message: "nope" } }, 500)));
    await expect(
      aiJSONBatch<string[]>({
        access: { keys: ["sk-x"], mode: "user", model: "m" },
        clientId: "c",
        batches: [[{ role: "user", content: "a" }], [{ role: "user", content: "b" }]],
        parallel: true,
      })
    ).rejects.toThrow();
  });
});

describe("applyRevisions logging (what to promote into OVERRIDES)", () => {
  const newLog = (): RevisionLog => ({ applied: [], rejected: [] });

  it("records an applied correction with both readings", () => {
    const lines = ["一番星を見た"];
    const base = [[{ t: "一番", r: "いちばん" }, { t: "星", r: "ほし" }, { t: "を" }, { t: "見", r: "み" }, { t: "た" }]];
    const log = newLog();
    applyRevisions(base, lines, [
      { i: 0, segs: [{ t: "一番星", r: "いちばんぼし" }, { t: "を" }, { t: "見", r: "み" }, { t: "た" }] },
    ], log);
    expect(log.applied).toContainEqual({ line: 0, run: "一番星", from: "", to: "いちばんぼし" });
    expect(log.rejected).toHaveLength(0);
  });

  it("records why a correction was refused", () => {
    const lines = ["今日は一日中雨だった"];
    const base = [[{ t: "今日", r: "きょう" }, { t: "は" }, { t: "一日中", r: "いちにちじゅう" }, { t: "雨", r: "う" }, { t: "だった" }]];
    const log = newLog();
    applyRevisions(base, lines, [
      { i: 0, segs: [{ t: "今日", r: "きょう" }, { t: "は" }, { t: "一日中", r: "はいちにちじゅう" }, { t: "雨", r: "あめ" }, { t: "だった" }] },
    ], log);
    expect(log.rejected[0]).toMatchObject({ run: "一日中", why: "reading swallowed the kana in front of it" });
    // ...and the good half of the same reply is still recorded as applied.
    expect(log.applied).toContainEqual({ line: 0, run: "雨", from: "う", to: "あめ" });
  });

  it("stays silent when no log is passed", () => {
    const lines = ["星"];
    const base = [[{ t: "星", r: "ほし" }]];
    expect(() => applyRevisions(base, lines, [{ i: 0, segs: [{ t: "星", r: "ぼし" }] }])).not.toThrow();
  });
});
