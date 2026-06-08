# 🎤 SingAlong

An embed-based karaoke web app. A TV/laptop shows the **host screen**; guests
join from their **phones** to search YouTube and queue songs. Unlike
[pikaraoke](https://github.com/vicwomg/pikaraoke), it **never downloads** — it
streams via the YouTube IFrame Player API, so there's no wait and you can
instantly **seek to any part** of a song.

## Features

- 📺 **Host screen** — plays the video, shows now-playing + up-next, and a QR
  code so guests can join by scanning.
- 📱 **Phone remote** — search YouTube (karaoke-only toggle) or paste a link,
  add songs with your name, control playback, and **scrub/seek live**.
- 🔄 **Real-time sync** over Socket.IO (queue, play/pause/skip/seek).
- ⭐ **Favorites & Recently played** — persisted in SQLite for one-tap re-adding.
- 🚫 **Embedding-safe** — auto-skips videos that can't be embedded.

## Architecture

- **Next.js (App Router) + React + Tailwind** UI.
- **Custom server** (`server.ts`) wraps Next.js and attaches **Socket.IO**.
  Live room state is in-memory (`lib/rooms.ts`); a party is short-lived.
- **SQLite** (`lib/db.ts`) persists history + favorites (single file, no
  external service).
- **YouTube IFrame Player API** plays + seeks on the host. **YouTube Data API
  v3** powers search (server-side, key hidden).

> Why a custom server (not Vercel)? WebSockets need a long-lived process.
> Serverless can't hold them — so we run one Node process on a VM.

## Local development

```bash
cp .env.local.example .env.local   # add YOUTUBE_API_KEY (optional, for search)
npm install
npm run dev                        # http://localhost:3000
```

Open the host on your laptop and the remote on your phone (same Wi-Fi) using
your machine's LAN IP, e.g. `http://192.168.1.50:3000`. The host screen's QR
code links straight to the remote.

- **Search** needs a free YouTube Data API key — see `.env.local.example`.
- **Pasting links** works without any key.

## Deploy (Oracle Cloud / GCP VM)

1. **Provision** an always-free VM (Oracle Ampere is generous) running Ubuntu.
   Open ports 80 and 443 in both the cloud security list *and* the VM firewall.
2. **Get a domain** — a free [DuckDNS](https://www.duckdns.org) subdomain works;
   point it at the VM's public IP.
3. **Build & install the app:**
   ```bash
   git clone <your-repo> ~/karaoke && cd ~/karaoke
   npm ci && npm run build
   ```
4. **Run it as a service** (auto-restart, starts on boot):
   ```bash
   sudo cp deploy/singalong.service /etc/systemd/system/
   # edit the file: set User, WorkingDirectory, YOUTUBE_API_KEY
   sudo systemctl daemon-reload && sudo systemctl enable --now singalong
   ```
5. **HTTPS via Caddy** (auto Let's Encrypt + WebSocket proxying):
   ```bash
   # install Caddy, then:
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # set your domain inside
   sudo systemctl restart caddy
   ```

Visit `https://your-subdomain.duckdns.org` — create a room on the TV, scan the
QR from any phone (even on cellular), and sing.

## Trade-off vs. pikaraoke

Embedding YouTube directly means no download/disk use and instant seeking, but
**no pitch/key shifting or vocal removal** (you can't process YouTube's stream).
Search "<song> karaoke" for instrumental tracks instead.
