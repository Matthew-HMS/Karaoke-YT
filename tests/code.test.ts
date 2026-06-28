import { describe, expect, it } from "vitest";
import {
  generateClientCode,
  isValidCode,
  isValidPassword,
  normalizeCode,
  normalizePassword,
} from "@/lib/code";

// The room-code alphabet deliberately drops easily-confused glyphs (0/1/I/O).
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

describe("generateClientCode", () => {
  it("returns a 4-char code from the safe alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateClientCode();
      expect(code).toHaveLength(4);
      expect([...code].every((c) => CODE_CHARS.includes(c))).toBe(true);
      // Generated codes are always valid by construction.
      expect(isValidCode(code)).toBe(true);
    }
  });
});

describe("normalizeCode", () => {
  it("uppercases the input", () => {
    expect(normalizeCode("abcd")).toBe("ABCD");
  });

  it("strips characters outside the alphabet (incl. 0/1/I/O)", () => {
    expect(normalizeCode("a1b2")).toBe("AB2"); // 1 removed
    expect(normalizeCode("OIL0")).toBe("L"); // O, I, 0 removed
    expect(normalizeCode("a-b c.d")).toBe("ABCD");
  });

  it("caps the result at 4 characters", () => {
    expect(normalizeCode("ABCDEFG")).toBe("ABCD");
  });

  it("returns an empty string when nothing is valid", () => {
    expect(normalizeCode("0110oi")).toBe("");
  });
});

describe("isValidCode", () => {
  it("accepts exactly 4 alphabet chars", () => {
    expect(isValidCode("ABCD")).toBe(true);
    expect(isValidCode("2345")).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isValidCode("ABC")).toBe(false);
    expect(isValidCode("ABCDE")).toBe(false);
    expect(isValidCode("")).toBe(false);
  });

  it("rejects excluded/invalid characters", () => {
    expect(isValidCode("AB1D")).toBe(false); // 1
    expect(isValidCode("ABID")).toBe(false); // I
    expect(isValidCode("ABOD")).toBe(false); // O
    expect(isValidCode("abcd")).toBe(false); // lowercase
  });
});

describe("normalizePassword", () => {
  it("uppercases and keeps the full alphanumeric set (incl. 0/1/I/O)", () => {
    expect(normalizePassword("ab12")).toBe("AB12");
    expect(normalizePassword("oil0")).toBe("OIL0");
  });

  it("strips non-alphanumerics and caps at 4", () => {
    expect(normalizePassword("a-b!c@d")).toBe("ABCD");
    expect(normalizePassword("abcde")).toBe("ABCD");
  });
});

describe("isValidPassword", () => {
  it("accepts 4 alphanumeric chars", () => {
    expect(isValidPassword("AB12")).toBe(true);
    expect(isValidPassword("OIL0")).toBe(true);
  });

  it("rejects bad length, lowercase, or symbols", () => {
    expect(isValidPassword("AB1")).toBe(false);
    expect(isValidPassword("abcd")).toBe(false);
    expect(isValidPassword("AB1!")).toBe(false);
  });
});
