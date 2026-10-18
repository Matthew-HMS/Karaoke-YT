import { describe, expect, it } from "vitest";
import { alignReading, furiganaLinesLocal } from "@/lib/furiganaLocal";
import type { FuriganaSegment } from "@/lib/types";

// Loading the IPADIC dictionary takes a second or two the first time; every
// later call reuses the same tokenizer.
const DICT_TIMEOUT = 30_000;

const render = (segs: FuriganaSegment[]) =>
  segs.map((s) => (s.r ? `${s.t}(${s.r})` : s.t)).join("");

const readingOf = (segs: FuriganaSegment[], text: string) =>
  segs.find((s) => s.t === text)?.r;

describe("alignReading", () => {
  it("spreads a reading across kanji runs, leaving okurigana bare", () => {
    expect(alignReading("過ごした", "スゴシタ")).toEqual([{ t: "過", r: "す" }, { t: "ごした" }]);
  });

  it("gives an all-kanji token the whole reading", () => {
    expect(alignReading("世界", "セカイ")).toEqual([{ t: "世界", r: "せかい" }]);
  });

  it("annotates nothing when there is no kanji", () => {
    expect(alignReading("カラオケ", "カラオケ")).toEqual([{ t: "カラオケ" }]);
  });

  // The caller must be able to tell "no reading" from a wrong one: an invented
  // reading would render ruby over the wrong characters.
  it("returns null rather than guess when the reading cannot be aligned", () => {
    expect(alignReading("夜露死苦", undefined)).toBeNull();
    expect(alignReading("今日", "")).toBeNull();
    expect(alignReading("続く", "ゼンゼンチガウ")).toBeNull();
  });
});

describe("furiganaLinesLocal", () => {
  it(
    "reconstructs every line exactly, whatever the script",
    async () => {
      const lines = [
        "君が僕に見せてくれた",
        "世界はとても綺麗だったな",
        "カラオケ",
        "",
        "Hello world 123",
        "  spaced  line  ",
        "「さよなら」「ありがとう」声の限り",
      ];
      const out = await furiganaLinesLocal(lines);
      expect(out).toHaveLength(lines.length);
      out.forEach((segs, i) => {
        expect(segs.map((s) => s.t).join("")).toBe(lines[i]);
      });
    },
    DICT_TIMEOUT
  );

  it(
    "puts readings only on kanji, never on kana",
    async () => {
      const [segs] = await furiganaLinesLocal(["君が僕に見せてくれた"]);
      for (const s of segs) {
        if (s.r) expect(s.t).toMatch(/^[一-龯々]+$/);
      }
      expect(readingOf(segs, "君")).toBe("きみ");
      expect(readingOf(segs, "僕")).toBe("ぼく");
    },
    DICT_TIMEOUT
  );

  it(
    "applies the overrides IPADIC gets wrong in context",
    async () => {
      const [aiOshi, futari, hoka, itsumo] = await furiganaLinesLocal([
        "そんな日々もどこか愛おしくて",
        "二人だけの空が広がる夜に",
        "他の誰でもない君だ",
        "それはいつも通り",
      ]);
      expect(readingOf(aiOshi, "愛")).toBe("いと"); // not あい
      expect(readingOf(futari, "二人")).toBe("ふたり"); // not ににん
      expect(readingOf(hoka, "他")).toBe("ほか"); // not た
      expect(readingOf(itsumo, "通")).toBe("どお"); // not とおり
    },
    DICT_TIMEOUT
  );

  it(
    "reads counters written with half-width digits",
    async () => {
      const [one, two] = await furiganaLinesLocal(["1人でむせて", "2人で歩く"]);
      expect(readingOf(one, "1人")).toBe("ひとり"); // not にん
      expect(readingOf(two, "2人")).toBe("ふたり");
    },
    DICT_TIMEOUT
  );

  it(
    "voices a compound IPADIC splits in two (rendaku)",
    async () => {
      const [ichibanboshi] = await furiganaLinesLocal(["一番星を掻き消すような"]);
      expect(readingOf(ichibanboshi, "一番星")).toBe("いちばんぼし"); // not いちばん + ほし
    },
    DICT_TIMEOUT
  );

  it(
    "annotates a line a model previously left bare",
    async () => {
      // 当たり前 came back with no reading from the model on a real song.
      const [segs] = await furiganaLinesLocal(["当たり前と思っていた日常も"]);
      expect(render(segs)).toContain("当(あ");
      expect(readingOf(segs, "日常")).toBe("にちじょう");
    },
    DICT_TIMEOUT
  );

  it(
    "leaves a line with no kanji as one bare segment",
    async () => {
      const out = await furiganaLinesLocal(["ひらがなだけ", "カタカナダケ", "english only"]);
      for (const segs of out) {
        expect(segs).toHaveLength(1);
        expect(segs[0].r).toBeUndefined();
      }
    },
    DICT_TIMEOUT
  );
});
