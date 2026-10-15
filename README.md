# 🎤 SingAlong

An embed-based karaoke web app. A TV/laptop shows the **host screen**; guests
join from their **phones** to search YouTube and queue songs. It **never downloads** — it
streams via the YouTube IFrame Player API, so there's no wait and you can
instantly **seek to any part** of a song.

## Features

- 📺 **Host screen** — the video stays on the left; a phone-sized panel on the
  right has the **same Search / Faves / Recent / Queue tabs as the remote** (so
  you can browse/queue while watching), playback controls + seek in the Queue
  tab, a join QR, the **room password**, and a 🎉 reactions button. The footer's
  **progress bar is draggable** — tap or drag it (or use the arrow keys) to
  scrub, and every host screen jumps with you — and a **volume slider** next to
  it sets the TV's level. Responsive (stacks on a phone), with a
  **fullscreen** toggle for the TV. While a song is playing the host holds a
  **Screen Wake Lock** so a phone-as-host won't dim/lock and pause the embed
  (browsers still pause the video if you switch away from the tab).
- 🔐 **Password-protected rooms** — the host sets a 4-letter password when
  creating; guests need the code *and* the password, and **co-hosts** opening
  the same room must enter it too (they never overwrite it). A code with no
  active room shows a clear "room not found".
- 👥 **Multiple hosts / co-hosting** — several TV screens can share one room;
  play/pause/seek/skip sync across all of them, and a newly-opened host jumps to
  the song already in progress.
- 📱 **Phone remote** — search, queue songs, control playback, and
  **scrub/seek live**. The search field stays **pinned at the top** while you
  scroll results, and **Skip** asks for confirmation first so you don't cut
  someone off by accident. The singer shown on the big screen is your Google
  name when signed in, otherwise "Guest".
- 🔎 **Quota-free search** via **yt-dlp** (fallback to the YouTube Data API),
  with a **"Karaoke versions only"** toggle, **Load more** paging, and your
  favorites pinned to the top. Titles clamp to two lines — **tap** a result's
  title to reveal its full name. Paste a single link **or a whole playlist**.
- 🧭 **Recommendations** — the Search tab (the **default tab** on entering a room)
  isn't blank before you type: signed-out users see **"Recommended top hits"** — a
  blend of **~70% familiar curated classics + ~30% YouTube's live Most Popular
  chart**, kept **≥70% Chinese**, so it's not all brand-new songs; randomly
  ordered so the feed varies, with a **Load more** button. (Without an API key it
  uses the curated pool of ~260 famous songs alone.) Signed-in users instead get
  a personalized **"For you"** feed built from their play history + favorites
  (seeds expanded via YouTube's Mix radio, ranked by cross-seed agreement, with
  your **favorites filtered out** — songs you've only played before can still
  resurface, since people like singing the same songs again). The Player tab's
  **Related** sub-tab shows songs related to whatever's currently playing — and
  when the queue runs dry it keeps suggesting, seeded off the last song the room
  played, so there's always something to queue up next. Related/For-you are quota-free
  (yt-dlp); hour-long compilations and live-radio streams are filtered out (real
  songs, ≤10 min) so every pick is a single singable song.
- 🎶 **Lyrics** — **swipe** the now-playing card left to flip from the song +
  play controls to the **lyrics** (header swaps "Now playing" ↔ "Lyrics"; swipe
  right or tap the dots to go back). Time-synced lyrics **highlight the current
  line** in step with playback; plain-only lyrics show as scrollable text. A
  **−/+ sync nudge** shifts the timing for music videos whose intro/outro drifts
  from the studio track, and that offset is **saved per video** so it sticks on
  later plays. Sourced from **LRCLIB** (free, no key) with an optional
  **Musixmatch** (RapidAPI) fallback; results — including misses — are cached in
  SQLite to stay within free quotas. Signed-in users get a **⚐ Report** button
  (with a confirm popup) for wrong lyrics: the server remembers that match as
  rejected and re-queries to find a **different match** next time. The **host
  screen** shows a **↩ Restore** button (only for songs whose lyrics were
  reported) to undo a mistaken report.
- 🔄 **Real-time sync** over Socket.IO (queue, play/pause/skip/seek).
- ↕️ **Drag-to-reorder** the queue (drag the ⠿ grip).
- 👤 **Sign in with Google** (Auth.js) for **personal favorites**, sortable by
  newest-added or your own play count; "Recent" is each room's own play history.
  Guests can use everything without an account.
- 🎲 **Random favorite** — one tap to queue a random song you've starred.
- 🎉 **Sing & Reactions menu** — one floating button on the phone opens a panel
  with both **Sing** (set your name + start mic scoring) and **Reactions** —
  sound effects (applause, whistle, airhorn, ta-da, drumroll, sad-trombone) that
  play one-at-a-time on the TV (real `.mp3` clips in `public/sfx/`, with an
  in-browser synth fallback). Closing the panel never stops an in-progress take
  (the mic lives in a page-level hook); the button keeps showing your live note.
  The same menu has a **🎡 Random singer** wheel: a **shared** name list (seeded
  from whoever's queued songs and synced room-wide, so every phone edits and sees
  the same candidates) that, on a tap from any phone, **spins on the TV** for the
  whole room to watch and lands on one name (the phone picks the winner + spin and
  broadcasts it to the host), with a drumroll → applause.
- 🎯 **Pitch & score** — set a name and tap **🎤 Sing** (in the menu above) to
  share the phone's mic; the browser detects your pitch (McLeod Pitch Method,
  `lib/pitch.ts`) and streams it to the TV, which paints a scrolling **pitch
  ribbon** over the video and a live **score** labelled with the singer's name
  (works for guests — the name is the persisted `singer-name`, no sign-in
  needed). When several phones sing, a live **leaderboard** ranks them by name,
  and an **end-of-song score card** crowns the winner. Mic stays on the phone;
  only pitch numbers travel.
- 🎼 **Reference target line + melody scoring** — because the song plays in a
  cross-origin YouTube iframe whose audio we can't read, the "what note should
  you hit" line is generated server-side: when a song is queued,
  `lib/reference.ts` pipes `yt-dlp → ffmpeg → lib/pitch.ts` to scan the audio
  into a compact pitch contour (cached in SQLite, ~10–25 s/song, hidden behind
  the queue, reused forever). In production that scan is offloaded to a small
  worker on a non-walled IP, because YouTube bot-walls datacenter addresses —
  see [k8s/README.md](k8s/README.md#off-cluster-target-pitch-worker-recommended).
  The TV draws it as a blue **Target** lane scrolling
  in song-time. **When a contour is ready the score becomes a melody match** —
  the trace turns green only when you hit the *right* note (octave-folded, so any
  octave counts), red when you're on a wrong note even if it's in tune, and the
  score rewards tracking the tune (`🎯 melody match`). With no contour yet it
  falls back per-sample to self-scoring (steadiness + in-tune-ness, `🎵 in tune`).
  Color and score both read the note drawn directly under your dot, so green
  always means "on the blue line." Requires `ffmpeg` on PATH (already in the Docker image).
  Monophonic detection on a full mix is noisy on dense arrangements — best on
  vocal-forward songs.
- 🧑‍🏫 **First-run tour + "What's new"** — a new host gets a **guided spotlight
  tour** of the big-screen view (join QR/code, the video stage, the tabs, the
  🎤 Controls menu, and fullscreen), one step at a time. It shows only once
  (tracked per-device in `localStorage`); the **?** button in the panel header
  replays it anytime. After an update, a **"What's new"** modal lists the new
  features the first time that device loads the app. The version and changelog
  live in `lib/version.ts` — bump `APP_VERSION` and prepend a `CHANGELOG` entry
  when you ship a user-visible feature (keep `package.json`'s version in sync).
- 🤖 **AI features (OrcaRouter)** — optional, via an OpenAI-compatible gateway
  using a **free model**, so they cost nothing (rate-limited, not billed):
  - ✨ **Mood search** — in the Search tab, type a vibe ("upbeat mandarin party
    songs", "sad 90s cantonese ballads") and tap **✨ Ask AI**; the model proposes
    real songs that are resolved through the normal quota-free search (so there
    are **no dead links**), shown under an "AI picks" header. **Enter** still runs
    a plain literal search — the two buttons disambiguate intent.
  - 🇯🇵 **Japanese reading aid** — a **⚙ Settings** mode adds either **furigana**
    (hiragana **above each kanji**, via `<ruby>`) or Hepburn **romaji** under each
    line (kana-detected; Chinese is left alone). Cached per-video in SQLite; the
    furigana output is reconstruction-checked so it can never alter the lyrics.
  - 🌏 **Lyrics translation** — a **⚙ Settings** language dropdown (English, 中文,
    日本語, 한국어, Español, …) translates the lyrics line-by-line under each line
    (meaning, not pronunciation). Skipped when the song is already in that language;
    cached per `(video, language)` and chunked for long songs like romaji.
  - 🧹 **Smart lyrics cleanup** — when the normal lyrics lookup misses on a messy
    title, the model extracts a clean `{artist, track}` and retries once, raising
    the hit-rate. Fires only on a miss; the result is cached like any other.
  - 🔑 **Keys & free quota** — set `ORCAROUTER_API_KEY` on the **server** (never
    exposed to the browser) and AI works for everyone, up to `AI_FREE_LIMIT`
    (default **5**) uses per Google account / per guest device on the shared key.
    Each free key is ~50 requests/day, so `ORCAROUTER_API_KEY` accepts a
    **comma-separated pool** of keys and fails over to the next on a 429.
    After that a user pastes **their own** free key in ⚙ Settings (kept on their
    device; a ⧉ referral button links out to get one). The deployer can set a
    private `AI_BYPASS_SECRET` word to use the server key with no limit.
    Quota exhaustion surfaces as a friendly "try again / add your key" hint;
    without any key, AI affordances are hidden and the rest works unchanged.
  - 💳 **Paid fallback** — the free model's capacity is capped **globally, not per
    key**: when it's saturated *every* key gets a 429 whose cooldown runs to
    **hours**, credits or not. So a free-model 429 retries once on a fixed cheap
    paid model (`ORCAROUTER_PAID_MODEL`, fractions of a cent per song) instead of
    dead-ending. Shared-key use (guests *and* `AI_BYPASS_SECRET`) falls back to
    `ORCAROUTER_PAID_KEY`; a user's **own** key falls back on *their* key, so
    pasting a credited key is enough to ride out a cooldown — no model to pick.
    Set a Model in ⚙ Settings and that choice is honored as-is, no fallback.
- ⚙ **Settings overlay** — a per-device settings panel (the ⚙ button) holding the
  AI key + toggles and the room's **Target-line** toggle.
- 🚫 **Embedding-safe** — auto-skips videos that can't be embedded.

## Architecture

- **Next.js (App Router) + React + Tailwind** UI.
- **Custom server** (`server.ts`) wraps Next.js and attaches **Socket.IO**.
  Live room state (queue, now-playing, per-room recent) is in-memory
  (`lib/rooms.ts`); a party is short-lived.
- **Search:** `lib/ytsearch.ts` shells out to **yt-dlp** (no API quota);
  `lib/search.ts` falls back to the **YouTube Data API** if yt-dlp fails, and
  caches results.
- **Region-aware discovery:** discovery runs on the server, so by default every
  feed reflects the *server's* region — which is how a song gets found + queued
  but then won't play for someone in another country. `lib/region.ts` resolves
  the viewer's country and the server biases results toward region-playable
  uploads (yt-dlp `gl=`, Data API `regionCode=`); feeds are cached per region.
  Region is resolved (`regionFromRequest`) in priority order: an **`X-Country`
  GeoIP header** from nginx (IP-accurate — what YouTube actually enforces; see
  `k8s/README.md` §5b), else the client's **language-based** `?region=XX` hint
  (from `navigator.language`), else none. It only *biases* discovery — a
  genuinely region-locked video still shows the "Not available in your region"
  notice on the blocked screen at playback.
- **Recommendations:** `lib/recommend.ts` orchestrates trending / related /
  personalized feeds (yt-dlp Mix radio + charts search, in-process cached),
  served by `/api/trending`, `/api/related`, and `/api/recommendations`.
- **Auth:** **Auth.js** with Google (`auth.ts`); favorites are scoped to the
  signed-in user.
- **SQLite** (`lib/db.ts`) persists per-user favorites (single file, no external
  service).
- **YouTube IFrame Player API** plays + seeks on the host. **Web Audio API**
  (`lib/sfx.ts`) synthesizes the sound effects.

> Why a custom server (not Vercel)? WebSockets need a long-lived process.
> Serverless can't hold them — so we run one Node process on a VM.

## Local development

```bash
cp .env.local.example .env.local   # fill in keys (see below)
npm install
brew install yt-dlp                # for quota-free search (or apt/pipx on Linux)
npm run dev                        # http://localhost:3000
```

Open the host on your laptop and the remote on your phone (same Wi-Fi) using
your machine's LAN IP, e.g. `http://192.168.1.50:3000` (add it to
`allowedDevOrigins` in `next.config.ts`). The host screen's QR code links to the
remote.

Environment (`.env.local`):
- `YOUTUBE_API_KEY` — fallback search + pasted-link metadata (yt-dlp covers the
  main search path).
- `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL` — Google
  sign-in. `AUTH_URL` must be your public origin (required behind a proxy/tunnel).
- `RAPIDAPI_KEY` — *optional* Musixmatch lyrics fallback via the
  `musixmatch-lyrics-songs` RapidAPI provider (used only when LRCLIB has
  nothing; returns synced lyrics too). Lyrics work without it via LRCLIB alone.
  Override the host with `MUSIXMATCH_RAPIDAPI_HOST` if needed (defaults to
  `musixmatch-lyrics-songs.p.rapidapi.com`).
- `ORCAROUTER_API_KEY` — *optional* server key that enables the AI features
  (mood search, romaji, smart lyrics cleanup) for everyone, on a free model.
  **Server-only — never sent to the browser; do not prefix with `NEXT_PUBLIC_`.**
  Users can also paste their own key in ⚙ Settings. Optional overrides:
  `ORCAROUTER_API_BASE_URL` (default `https://api.orcarouter.ai/v1`),
  `ORCAROUTER_MODEL` (default `orcarouter/free`).
- `ORCAROUTER_PAID_KEY` — *optional* **credited** key used only when the free
  model is in one of its (global, multi-hour) cooldowns, on the fixed cheap
  `ORCAROUTER_PAID_MODEL` (default `deepseek/deepseek-v4-flash`). Without it,
  shared-key AI simply degrades when the free pool is saturated. Server-only.
- Trending (signed-out "Top hits") uses YouTube's **Most Popular** music chart
  via the Data API when `YOUTUBE_API_KEY` is set — quota-cheap (~1 unit/region,
  refreshed hourly). `TRENDING_REGION` (*optional*, default `TW,US,JP`) is a
  comma-separated list of region codes blended together — the viewer's own
  detected region is added to this blend so their playable hits are represented.
  Without a key (or if the
  chart fails) it falls back to randomly sampling a built-in pool of ~260 famous
  songs. To pin a source instead: `TRENDING_PLAYLIST_ID` — a YouTube playlist id
  (wins if set); or `TRENDING_QUERY` — a single search query. Both *optional*.

## Testing

Unit tests (Vitest) cover the core logic: room-code/password validation
(`lib/code.ts`), time formatting (`lib/format.ts`), the in-memory room/queue
engine (`lib/rooms.ts`), YouTube URL/duration parsing + the Data-API helpers
(`lib/youtube.ts`), the search orchestrator with cache + fallback (`lib/search.ts`),
the yt-dlp scraper (`lib/ytsearch.ts`, with `child_process` mocked), the
SQLite favorites/plays layer (`lib/db.ts`, against an in-memory DB), and the
lyrics title-cleanup + LRC parser (`lib/lyrics.ts`).

```bash
npm test           # run once
npm run test:watch # watch mode
```

CI/CD ([`.github/workflows/build-image.yml`](.github/workflows/build-image.yml))
runs the type-checker and the full suite on every pull request and every push to
`main`; the image is built and deployed **only after those tests pass**.

## Deploy

Two supported paths:
- **Kubernetes (production)** — single-replica Deployment exposed as a NodePort,
  fronted by the node's existing nginx (TLS), image built in CI → GHCR. See
  **[k8s/README.md](k8s/README.md)**.
- **Single VM + systemd** — the simpler setup below.

### Single VM (Oracle Cloud / GCP VM)

1. **Provision** an always-free VM (Oracle Ampere is generous) running Ubuntu.
2. **Domain:** a free [DuckDNS](https://www.duckdns.org) subdomain pointed at the
   VM's public IP (many subdomains can share one IP).
3. **Install** Node 20, git, and the **latest yt-dlp**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs git build-essential python3
   sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp
   ```
4. **Clone, configure, build:**
   ```bash
   git clone https://github.com/Matthew-HMS/Karaoke-YT.git ~/karaoke && cd ~/karaoke
   nano .env.local                 # YOUTUBE_API_KEY, AUTH_*, AUTH_URL=https://you.duckdns.org
   npm ci && npm run build
   ```
5. **Run as a service** (loads `.env.local` via `EnvironmentFile`):
   ```bash
   sudo cp deploy/singalong.service /etc/systemd/system/   # set User/paths inside
   sudo systemctl daemon-reload && sudo systemctl enable --now singalong
   ```
6. **HTTPS reverse proxy** — the app listens on `localhost:3000`; front it with
   **Caddy** (`deploy/Caddyfile`, auto Let's Encrypt) *or*, if nginx already owns
   80/443, add an nginx vhost with WebSocket upgrade headers + certbot. Open
   ports 80/443 in both the Oracle Security List and the VM firewall.
7. **Google:** add `https://you.duckdns.org/api/auth/callback/google` to the
   OAuth client's redirect URIs.

### Continuous deploy
`.github/workflows/deploy.yml` SSHes into the VM on every push to `main`
(git pull → `npm ci` → build → restart). Set repo secrets `DEPLOY_HOST`,
`DEPLOY_USER`, `DEPLOY_PORT`, `DEPLOY_SSH_KEY`, and a passwordless-sudo rule for
`systemctl restart singalong`.
