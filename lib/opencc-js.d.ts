// opencc-js ships no types; this covers the one call lib/chineseScript.ts makes.
declare module "opencc-js" {
  type Locale = "cn" | "tw" | "twp" | "hk" | "jp" | "t";
  export function Converter(opts: { from: Locale; to: Locale }): (text: string) => string;
}
