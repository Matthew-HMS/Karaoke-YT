// Recommendation engine. Related songs + personalized recs are quota-free (they
// lean on yt-dlp's "Mix" radio and the search orchestrator). Trending uses
// YouTube's Most Popular chart (Data API, ~1 quota unit/region, refreshed
// hourly) with a quota-free curated fallback. Results are cached in-process like
// lib/search.ts so a tab is never blank and the budget is barely touched.

import { searchSongs } from "./search";
import { getPlaylistViaYtDlp, getRelatedViaYtDlp } from "./ytsearch";
import { getMostPopularMusic, type SearchResult } from "./youtube";
import { listFavorites, listTopPlayed } from "./db";

const RELATED_TTL_MS = 30 * 60 * 1000; // a song's "related" list is stable
const TRENDING_TTL_MS = 60 * 60 * 1000; // refresh the trending chart hourly
const RECS_TTL_MS = 15 * 60 * 1000; // refresh personalized recs occasionally

// Trending source. Default: YouTube's real "Most Popular" music chart, blended
// across TRENDING_REGION (comma-separated; default Taiwan + US + Japan for a
// Mandarin/English/Japanese mix). Needs YOUTUBE_API_KEY; if absent or the chart
// fails, we fall back to randomly sampling a curated pool of famous songs (see
// CURATED_HITS, quota-free yt-dlp). An explicit chart playlist
// (TRENDING_PLAYLIST_ID) or single search query (TRENDING_QUERY) overrides both.
const TRENDING_PLAYLIST_ID = process.env.TRENDING_PLAYLIST_ID; // optional
const TRENDING_QUERY = process.env.TRENDING_QUERY; // optional
const TRENDING_REGION = process.env.TRENDING_REGION || "TW,US,JP";

// Famous KTV songs as search queries (not video ids, which rot). getTrending
// samples these at random so the "Top hits" feed is full of real songs and
// varies between loads. ~215 songs: ~138 Chinese (Mandarin/Cantonese, all eras),
// 50 English, 28 Japanese — see CHINESE_HITS / ENGLISH_HITS / JAPANESE_HITS.
const CHINESE_HITS = [
  // 周杰伦 Jay Chou
  "周杰伦 七里香", "周杰伦 晴天", "周杰伦 告白气球", "周杰伦 稻香", "周杰伦 青花瓷", "周杰伦 夜曲", "周杰伦 安静",
  "周杰伦 听妈妈的话", "周杰伦 龙卷风",
  // 林俊杰 JJ Lin
  "林俊杰 江南", "林俊杰 修炼爱情", "林俊杰 可惜没如果", "林俊杰 那些你很冒险的梦",
  "林俊杰 不为谁而作的歌", "林俊杰 一千年以后", "林俊杰 曹操",
  // 陈奕迅 Eason Chan
  "陈奕迅 十年", "陈奕迅 富士山下", "陈奕迅 K歌之王", "陈奕迅 浮夸",
  "陈奕迅 好久不见", "陈奕迅 红玫瑰", "陈奕迅 爱情转移", "陈奕迅 单车",
  // 张学友 Jacky Cheung
  "张学友 吻别", "张学友 一千个伤心的理由",
  // 五月天 Mayday
  "五月天 倔强", "五月天 突然好想你", "五月天 知足", "五月天 温柔",
  "五月天 拥抱", "五月天 干杯", "五月天 恋爱ING", "王菲 红豆",
  // 张惠妹 A-Mei
  "张惠妹 听海", "张惠妹 三天三夜", "张惠妹 剪爱", "张惠妹 记得",
  // 孙燕姿 Stefanie Sun
  "孙燕姿 遇见", "孙燕姿 我怀念的", "孙燕姿 天黑黑", "孙燕姿 绿光", "孙燕姿 开始懂了",
  // 蔡依林 Jolin Tsai
  "蔡依林 日不落", "蔡依林 倒带", "蔡依林 看我七十二变", "蔡依林 说爱你",
  // 梁静茹 Fish Leong
  "梁静茹 勇气", "梁静茹 可惜不是你", "梁静茹 宁夏", "梁静茹 暖暖", "梁静茹 崇拜",
  // 邓紫棋 G.E.M.
  "邓紫棋 泡沫", "邓紫棋 光年之外", "邓紫棋 喜欢你", "邓紫棋 来自天堂的魔鬼", "邓紫棋 倒数", "邓紫棋 再見", "邓紫棋 多遠都要在一起",
  // 邓丽君 Teresa Teng
  "邓丽君 月亮代表我的心", "邓丽君 甜蜜蜜", "邓丽君 我只在乎你", "邓丽君 小城故事",
  // 田馥甄 / 苏打绿 / 徐佳莹
  "田馥甄 小幸运", "田馥甄 魔鬼中的天使", "田馥甄 寂寞寂寞就好",
  "苏打绿 小情歌", "苏打绿 无与伦比的美丽", "苏打绿 你被写在我的歌里",
  "徐佳莹 身骑白马", "徐佳莹 失落沙洲",
  // 李荣浩 / 薛之谦 / 毛不易 / 周深 / 华晨宇
  "李荣浩 模特", "李荣浩 年少有为", "李荣浩 李白", "李荣浩 老街",
  "薛之谦 演员", "薛之谦 丑八怪", "薛之谦 绅士", "薛之谦 刚刚好",
  "毛不易 消愁", "毛不易 像我这样的人", "周深 大鱼", "华晨宇 烟火里的尘埃",
  // Throwbacks & ballads
  "费玉清 一剪梅", "张雨生 大海",
  "周传雄 黄昏", "光良 童话", "任贤齐 心太软", "任贤齐 对面的女孩看过来",
  "刘德华 忘情水", "莫文蔚 慢慢喜歡你", "萧敬腾 王妃", "萧敬腾 新不了情",
  "杨宗纬 洋葱", "杨宗纬 一次就好", "罗大佑 童年", "罗大佑 光阴的故事",
  "信乐团 死了都要爱", "信乐团 离歌",
  "韦礼安 还是会", "A-Lin 给我一个理由忘记", "A-Lin 有一种悲伤",
  "刘若英 后来", "刘若英 很爱很爱你", "蔡健雅 红色高跟鞋", "林忆莲 至少还有你",
  "范玮琪 一个像夏天一个像秋天", "杨丞琳 暧昧", "张韶涵 隐形的翅膀", "张韶涵 欧若拉",
  "S.H.E 不想长大", "张靓颖 终于等到你", "王心凌 爱你", "F.I.R. Lydia",
  // Mainland / rock / folk / internet
  "那英 征服", "那英 默", "朴树 那些花儿", "朴树 平凡之路",
  "许巍 蓝莲花", "汪峰 北京北京", "李宗盛 山丘", "李宗盛 凡人歌",
  "李健 贝加尔湖畔", "陶喆 爱很简单", "陶喆 普通朋友", "庾澄庆 情非得已",
  "林志炫 单身情歌", "张宇 用心良苦", "赵雷 成都", "逃跑计划 夜空中最亮的星",
  "许嵩 断桥残雪", "买辣椒也用券 起风了", "隔壁老樊 我曾", "任然 飞鸟和蝉",
  "周兴哲 以后别做朋友", "卢广仲 刻在我心底的名字", "告五人 披星戴月的想你",
  "胡夏 那些年", "陈绮贞 旅行的意义", "张震岳 思念是一种病", "凤凰传奇 月亮之上",
];

const ENGLISH_HITS = [
  "Queen Bohemian Rhapsody", "ABBA Dancing Queen", "Adele Someone Like You",
  "Adele Rolling in the Deep", "Ed Sheeran Perfect", "Ed Sheeran Shape of You",
  "Bruno Mars Just the Way You Are", "Bruno Mars Count on Me", "Bruno Mars When I Was Your Man",
  "Coldplay Yellow", "Coldplay Viva La Vida", "The Beatles Hey Jude",
  "John Lennon Imagine", "Whitney Houston I Will Always Love You", "Mariah Carey Hero",
  "Celine Dion My Heart Will Go On", "Backstreet Boys I Want It That Way", "Westlife My Love",
  "Michael Jackson Billie Jean", "Eagles Hotel California", "Bon Jovi It's My Life",
  "Guns N' Roses Sweet Child O' Mine", "Oasis Wonderwall", "Maroon 5 Sugar",
  "Taylor Swift Love Story", "Taylor Swift Shake It Off", "Katy Perry Firework",
  "Lady Gaga Shallow", "Lady Gaga Poker Face", "John Legend All of Me",
  "Sam Smith Stay With Me", "Justin Bieber Love Yourself", "Charlie Puth Attention",
  "Imagine Dragons Believer", "The Chainsmokers Closer", "Avril Lavigne Complicated",
  "Rihanna Diamonds", "Pink Just Give Me a Reason", "Christina Perri A Thousand Years",
  "Jason Mraz I'm Yours", "James Blunt You're Beautiful", "Carpenters Yesterday Once More",
  "Carpenters Top of the World", "Frank Sinatra My Way", "Elton John Your Song",
  "Lewis Capaldi Someone You Loved", "Billie Eilish bad guy", "Dua Lipa Levitating",
  "The Weeknd Blinding Lights", "Toto Africa",
];

const JAPANESE_HITS = [
  "米津玄師 Lemon", "米津玄師 馬と鹿", "YOASOBI アイドル",
  "Official髭男dism Pretender", "Official髭男dism Subtitle", "あいみょん マリーゴールド",
  "あいみょん 君はロックを聴かない", "King Gnu 白日", "LiSA 紅蓮華", "LiSA 炎",
  "宇多田ヒカル First Love", "宇多田ヒカル Automatic", "中島美嘉 雪の華",
  "一青窈 ハナミズキ", "back number 高嶺の花子さん", "RADWIMPS 前前前世",
  "RADWIMPS スパークル", "Mr.Children 名もなき詩", "Mr.Children Tomorrow never knows",
  "スピッツ チェリー", "X JAPAN 紅", "ZARD 負けないで", "浜崎あゆみ M",
  "SMAP 世界に一つだけの花", "嵐 Happiness", "秦基博 ひまわりの約束",
  "サザンオールスターズ TSUNAMI",
];

const CURATED_OTHER = [...ENGLISH_HITS, ...JAPANESE_HITS];

const MAX_RELATED = 25;
const MAX_RECS = 30;
const MAX_TRENDING = 25;
const RECS_SEEDS = 4; // how many of the user's songs to expand into related feeds

// Trending feed blend: ~70% from the curated pool (familiar classics), ~30% from
// YouTube's live chart (current hits) — the chart alone skewed too "new". And at
// least 70% of the feed should be Chinese. These are enforced as hard caps in
// composeTrending(), with per-bucket targets shaping the typical mix.
const TRENDING_CHART_SHARE = 0.3; // ≤30% of the feed from the live chart
const TRENDING_CHINESE_MIN = 0.7; // ≥70% of the feed Chinese
// How many curated songs to search (top-1 each) when building the pool, split so
// the curated portion is itself mostly Chinese.
const CURATED_CN_PICKS = 18;
const CURATED_OTHER_PICKS = 10;

// Keep only single, singable songs: drop hour-long compilations/megamixes AND
// live-radio streams (which report a 0/unknown duration). A real song has a real
// runtime under the cap.
const MAX_SONG_SEC = 10 * 60;
function singable(r: SearchResult): boolean {
  return r.durationSec > 0 && r.durationSec <= MAX_SONG_SEC;
}

// Fisher-Yates shuffle (non-mutating) — used to vary the trending feed per load.
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function dedupe(songs: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return songs.filter((s) => !seen.has(s.videoId) && seen.add(s.videoId));
}

// Heuristic: a Chinese title has Han characters but no Japanese kana / Korean
// hangul (which distinguishes it from Japanese titles that also use Han/Kanji).
// Only used to gauge the language of live-chart songs; curated songs are tagged
// by which list they came from.
function isChinese(r: SearchResult): boolean {
  return /[一-鿿]/.test(r.title) && !/[぀-ヿ가-힯]/.test(r.title);
}

// Search a random sample of curated song names (top result each) in parallel.
async function sampleSearch(list: string[], n: number): Promise<SearchResult[]> {
  const picks = shuffle(list).slice(0, n);
  const settled = await Promise.all(
    picks.map((q) =>
      searchSongs(q, { karaokeOnly: false, limit: 1 })
        .then((r) => r.results)
        .catch(() => [])
    )
  );
  return settled.flat().filter(singable);
}

type CacheEntry = { at: number; results: SearchResult[] };

// The trending source kept in buckets so composeTrending() can re-blend (and
// re-shuffle) per request. `override` is non-empty only when a playlist/query is
// pinned via env, in which case the blend is bypassed.
type TrendingPool = {
  at: number;
  override: SearchResult[];
  chart: SearchResult[];
  curatedCN: SearchResult[];
  curatedOther: SearchResult[];
};

const relatedCache = new Map<string, CacheEntry>();
let trendingPool: TrendingPool | null = null;
const recsCache = new Map<string, CacheEntry>();

// Strip the noise that makes a YouTube title a bad search query: bracketed tags
// like "(Official Video)" / "[HD]", a trailing "karaoke", and stray punctuation.
function cleanTitle(title: string): string {
  return title
    .replace(/[\(\[][^\)\]]*[\)\]]/g, " ")
    .replace(/\bkaraoke\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Related songs for a single video: YouTube's Mix radio, falling back to a
// keyword search on the cleaned title (the Data API dropped relatedToVideoId in
// 2023, so a search is the only quota-bearing fallback available).
export async function getRelated(
  videoId: string,
  title?: string
): Promise<SearchResult[]> {
  const hit = relatedCache.get(videoId);
  if (hit && Date.now() - hit.at < RELATED_TTL_MS) return hit.results;

  let results: SearchResult[] = [];
  try {
    results = await getRelatedViaYtDlp(videoId, MAX_RELATED);
  } catch (err) {
    console.warn(
      "[recommend] related mix failed:",
      err instanceof Error ? err.message : err
    );
  }

  if (results.length === 0 && title) {
    try {
      const { results: searched } = await searchSongs(cleanTitle(title), {
        karaokeOnly: false,
        limit: MAX_RELATED,
      });
      results = searched.filter((r) => r.videoId !== videoId);
    } catch {
      // leave results empty — the route will surface an empty list
    }
  }

  results = results.filter(singable);
  relatedCache.set(videoId, { at: Date.now(), results });
  return results;
}

// YouTube's real "Most Popular" music chart, blended across the configured
// regions (default Taiwan + US + Japan for a Mandarin/English/Japanese mix).
// Quota-cheap (1 unit/region) and only refreshed hourly, so it barely touches
// the daily budget. Needs YOUTUBE_API_KEY; empties if it isn't set / fails.
async function getTrendingFromChart(): Promise<SearchResult[]> {
  const regions = TRENDING_REGION.split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (regions.length === 0) return [];
  const settled = await Promise.allSettled(
    regions.map((r) => getMostPopularMusic(r, 20))
  );
  return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
}

// Build (hourly) the bucketed trending source: a pinned override, or the live
// chart + curated songs gathered in parallel. Curated is split CN/other so we
// can keep the feed Chinese-heavy.
async function buildTrendingPool(): Promise<TrendingPool> {
  const pool: TrendingPool = {
    at: Date.now(),
    override: [],
    chart: [],
    curatedCN: [],
    curatedOther: [],
  };

  if (TRENDING_PLAYLIST_ID) {
    try {
      pool.override = (await getPlaylistViaYtDlp(TRENDING_PLAYLIST_ID)).filter(singable);
    } catch (err) {
      console.warn(
        "[recommend] trending playlist failed:",
        err instanceof Error ? err.message : err
      );
    }
    return pool;
  }
  if (TRENDING_QUERY) {
    pool.override = await searchSongs(TRENDING_QUERY, { karaokeOnly: false, limit: 30 })
      .then((r) => r.results.filter(singable))
      .catch(() => []);
    return pool;
  }

  const [chart, curatedCN, curatedOther] = await Promise.all([
    getTrendingFromChart().catch((err) => {
      console.warn(
        "[recommend] trending chart failed:",
        err instanceof Error ? err.message : err
      );
      return [] as SearchResult[];
    }),
    sampleSearch(CHINESE_HITS, CURATED_CN_PICKS),
    sampleSearch(CURATED_OTHER, CURATED_OTHER_PICKS),
  ]);
  pool.chart = chart.filter(singable);
  pool.curatedCN = curatedCN;
  pool.curatedOther = curatedOther;
  return pool;
}

// Blend the bucketed pool into one feed: ~70% curated / ~30% chart, with a hard
// ≥70%-Chinese floor and ≤30%-chart cap. Per-bucket targets shape the typical
// mix; the caps guarantee the ratios even when a bucket runs short. Buckets are
// re-shuffled each call so the feed varies and "Load more" surfaces new songs.
function composeTrending(pool: TrendingPool): SearchResult[] {
  if (pool.override.length) {
    return dedupe(shuffle(pool.override)).slice(0, MAX_TRENDING);
  }

  const N = MAX_TRENDING;

  // Globally-deduped, freshly-shuffled candidate buckets.
  const seen = new Set<string>();
  const uniq = (songs: SearchResult[]) =>
    shuffle(songs).filter((s) => !seen.has(s.videoId) && seen.add(s.videoId));
  const chartCN = uniq(pool.chart.filter(isChinese));
  const chartOther = uniq(pool.chart.filter((s) => !isChinese(s)));
  const curCN = uniq(pool.curatedCN);
  const curOther = uniq(pool.curatedOther);

  const out: SearchResult[] = [];
  const added = new Set<string>();
  let nonCN = 0;
  const add = (s: SearchResult, cn: boolean) => {
    if (out.length >= N || added.has(s.videoId)) return;
    // Hard floor: keep the feed ≥ TRENDING_CHINESE_MIN Chinese at every step, so
    // the ratio holds even for a partial feed (not just a full 25).
    if (!cn && nonCN + 1 > (out.length + 1) * (1 - TRENDING_CHINESE_MIN)) return;
    out.push(s);
    added.add(s.videoId);
    if (!cn) nonCN++;
  };

  // Per-bucket targets shape the typical mix: ~70% curated / ~30% chart, crossed
  // with the Chinese majority. The Chinese floor is enforced in add(); the chart
  // share is soft (curated fills first in both the plan and the top-up, so the
  // chart lands at ~30% when curated is plentiful, but still fills if it's short).
  // [bucket, target, isChinese]
  const plan: [SearchResult[], number, boolean][] = [
    [curCN, Math.round(N * (1 - TRENDING_CHART_SHARE) * TRENDING_CHINESE_MIN), true],
    [curOther, Math.round(N * (1 - TRENDING_CHART_SHARE) * (1 - TRENDING_CHINESE_MIN)), false],
    [chartCN, Math.round(N * TRENDING_CHART_SHARE * TRENDING_CHINESE_MIN), true],
    [chartOther, Math.round(N * TRENDING_CHART_SHARE * (1 - TRENDING_CHINESE_MIN)), false],
  ];
  for (const [bucket, target, cn] of plan) {
    let taken = 0;
    for (const s of bucket) {
      if (taken >= target || out.length >= N) break;
      const before = out.length;
      add(s, cn);
      if (out.length > before) taken++;
    }
  }

  // Top up to N if buckets were short — curated before chart (to keep chart ≈30%),
  // Chinese before other (to hold the floor).
  for (const [bucket, cn] of [
    [curCN, true],
    [chartCN, true],
    [curOther, false],
    [chartOther, false],
  ] as [SearchResult[], boolean][]) {
    for (const s of bucket) {
      if (out.length >= N) break;
      add(s, cn);
    }
  }

  return shuffle(out);
}

// Anonymous "Top hits" feed: ~70% familiar curated songs + ~30% live chart, kept
// ≥70% Chinese. The bucketed pool is cached hourly; composeTrending re-blends and
// re-shuffles per call so the tab varies and "Load more" surfaces new songs.
export async function getTrending(): Promise<SearchResult[]> {
  if (!trendingPool || Date.now() - trendingPool.at >= TRENDING_TTL_MS) {
    trendingPool = await buildTrendingPool();
  }
  return composeTrending(trendingPool);
}

// Personalized recommendations: take the user's most-played + recently
// favorited songs as seeds, expand each into its related feed, then rank by how
// many seeds surfaced the same song (cross-seed agreement = stronger signal).
// Only favorited songs are removed; already-played songs stay eligible so they
// can resurface. With no history we just return trending.
export async function getRecommendations(
  userId: string
): Promise<SearchResult[]> {
  const hit = recsCache.get(userId);
  if (hit && Date.now() - hit.at < RECS_TTL_MS) return hit.results;

  // Seeds: favor the user's top plays, topped up with recent favorites. The
  // favorites list carries titles so any per-seed search fallback has a query.
  const favorites = listFavorites(userId, "added");
  const titleById = new Map(favorites.map((f) => [f.videoId, f.title]));
  const seedIds: string[] = [];
  for (const id of [...listTopPlayed(userId, RECS_SEEDS), ...favorites.map((f) => f.videoId)]) {
    if (!seedIds.includes(id)) seedIds.push(id);
    if (seedIds.length >= RECS_SEEDS) break;
  }

  if (seedIds.length === 0) {
    const trending = await getTrending();
    recsCache.set(userId, { at: Date.now(), results: trending });
    return trending;
  }

  const feeds = await Promise.all(
    seedIds.map((id) => getRelated(id, titleById.get(id)))
  );

  // Only filter out favorites — songs the user has *played* stay eligible so
  // they can resurface (people like singing the same songs again).
  const excluded = new Set(favorites.map((f) => f.videoId));
  const score = new Map<string, number>();
  const meta = new Map<string, SearchResult>();
  for (const feed of feeds) {
    for (const song of feed) {
      if (excluded.has(song.videoId) || seedIds.includes(song.videoId)) continue;
      score.set(song.videoId, (score.get(song.videoId) ?? 0) + 1);
      if (!meta.has(song.videoId)) meta.set(song.videoId, song);
    }
  }

  const results = [...meta.values()]
    .sort((a, b) => (score.get(b.videoId)! - score.get(a.videoId)!))
    .slice(0, MAX_RECS);

  // If seeds yielded nothing usable (everything filtered out), fall back to
  // trending rather than an empty "For you" list.
  const final = results.length > 0 ? results : await getTrending();
  recsCache.set(userId, { at: Date.now(), results: final });
  return final;
}
