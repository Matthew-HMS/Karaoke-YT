// Simplified ↔ Traditional Chinese, by dictionary (OpenCC) rather than by asking
// the model. Prompting "Traditional Chinese" isn't enough: free models drift
// into Simplified mid-song (and mix the two inside one line), so the script is
// forced here, after the fact, on every translation we serve. Characters only
// ("tw", not "twp"): swapping in Taiwanese vocabulary would rewrite words, and
// the same converter turns a Simplified-script song's own lyrics into
// Traditional, where only the script should change.

import { Converter } from "opencc-js";

export const toTraditional = Converter({ from: "cn", to: "tw" });
export const toSimplified = Converter({ from: "tw", to: "cn" });
