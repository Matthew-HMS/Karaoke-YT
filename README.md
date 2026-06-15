# 🎤 SingAlong

An embed-based karaoke web app. A TV/laptop shows the **host screen**; guests
join from their **phones** to search YouTube and queue songs. It **never downloads** — it
streams via the YouTube IFrame Player API, so there's no wait and you can
instantly **seek to any part** of a song.

## Features

- 📺 **Host screen** — the video stays on the left; a phone-sized panel on the
  right has the **same Search / Faves / Recent / Queue tabs as the remote** (so
  you can browse/queue while watching), playback controls + seek in the Queue
  tab, a join QR, the **room password**, and a 🎉 reactions button. A footer
  **volume slider** sets the TV's level. Responsive (stacks on a phone), with a
  **fullscreen** toggle for the TV.
- 🔐 **Password-protected rooms** — the host sets a 4-letter password when
  creating; guests need the code *and* the password, and **co-hosts** opening
  the same room must enter it too (they never overwrite it). A code with no
  active room shows a clear "room not found".
- 👥 **Multiple hosts / co-hosting** — several TV screens can share one room;
  play/pause/seek/skip sync across all of them, and a newly-opened host jumps to
  the song already in progress.
- 📱 **Phone remote** — search, queue songs with your name, control playback,
  and **scrub/seek live**.
- 🔎 **Quota-free search** via **yt-dlp** (fallback to the YouTube Data API),
  with a **"Karaoke versions only"** toggle, **Load more** paging, and your
  favorites pinned to the top. Paste a single link **or a whole playlist**.
- 🔄 **Real-time sync** over Socket.IO (queue, play/pause/skip/seek).
- ↕️ **Drag-to-reorder** the queue (drag the ⠿ grip).
- 👤 **Sign in with Google** (Auth.js) for **personal favorites**, sortable by
  newest-added or your own play count; "Recent" is each room's own play history.
  Guests can use everything without an account.
- 🎲 **Random favorite** — one tap to queue a random song you've starred.
- 🎉 **Reactions** — a button reveals sound effects (applause, whistle, airhorn,
  ta-da, drumroll, sad-trombone) that play one-at-a-time on the TV (real `.mp3`
  clips in `public/sfx/`, with an in-browser synth fallback).
- 🚫 **Embedding-safe** — auto-skips videos that can't be embedded.

## Architecture

- **Next.js (App Router) + React + Tailwind** UI.
- **Custom server** (`server.ts`) wraps Next.js and attaches **Socket.IO**.
  Live room state (queue, now-playing, per-room recent) is in-memory
  (`lib/rooms.ts`); a party is short-lived.
- **Search:** `lib/ytsearch.ts` shells out to **yt-dlp** (no API quota);
  `lib/search.ts` falls back to the **YouTube Data API** if yt-dlp fails, and
  caches results.
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

## Trade-off vs. pikaraoke

Embedding YouTube directly means no download/disk use and instant seeking, but
**no pitch/key shifting or vocal removal** (you can't process YouTube's stream).
Search "<song> karaoke" for instrumental tracks instead.
