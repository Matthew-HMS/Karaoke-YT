# 🎤 SingAlong

Instant karaoke for a room full of people. Put a TV or laptop on the **host
screen**, and everyone else queues songs from their **phone** — no app to
install, no files to download, no waiting between songs.

Songs stream straight from YouTube, so a song starts the moment it's picked and
you can jump to any part of it.

---

## Start singing in 30 seconds

**On the TV (the host):**

1. Open the app and type a **4-character password** of your choosing.
2. Tap **🎤 Start a room**. The big screen shows a **room code** and a **QR
   code**.
3. Leave this screen up — this is where the video, lyrics and scores appear.

**On everyone's phone (the guests):**

1. **Scan the QR code** on the TV (or open the app and enter the room code).
2. Enter the room password the host chose.
3. Search for a song and tap it to add it to the queue. That's it — it plays on
   the TV when its turn comes.

Guests don't need an account. Signing in with Google is optional and only adds
personal favourites.

---

## What you can do

### 📺 On the big screen

- The video plays on the left; a panel on the right has the **same tabs as a
  phone** (Search, ★ Faves, Recent, Player), so the host can browse and queue
  without picking up a phone.
- **Drag the progress bar** (or use the arrow keys) to scrub, and a **volume
  slider** sets the TV's level. Every screen in the room follows along.
- **Fullscreen** toggle for a clean TV picture, and the screen won't dim or
  lock mid-song.
- **Several TVs can share one room.** Play, pause, seek and skip stay in sync
  across all of them, and a screen that joins late jumps straight to the song
  already playing.
- A **guided tour** walks a first-time host through the screen. It shows once;
  the **?** button replays it anytime. After an update, a **"What's new"**
  panel lists what changed.

### 📱 From your phone

- Search, queue, reorder, pause, skip and **scrub the song live**.
- **Drag the ⠿ grip** to reorder the queue.
- **Skip asks for confirmation** first, so nobody gets cut off by accident.
- The search box stays pinned at the top while you scroll results, and tapping
  a long title reveals its full name.
- Your name shows on the big screen as the singer (your Google name if you're
  signed in, otherwise the name you set).

### 🔎 Finding songs

- **Search** any song, with a **"Karaoke versions only"** toggle and **Load
  more** for deeper results.
- **Paste a YouTube link** — or a whole **playlist** — to queue it directly.
- **Recommendations instead of a blank page.** The Search tab opens with
  **Recommended top hits** for guests, or a personal **For you** feed once
  you're signed in, built from what you've played and starred.
- **Related songs** for whatever is playing — and when the queue runs dry, the
  app keeps suggesting songs based on what the room has been singing, so
  there's always something to add.
- **✨ Ask AI** — describe a vibe instead of a title ("upbeat mandarin party
  songs", "sad 90s cantonese ballads") and get real, queueable picks. Pressing
  Enter still runs a plain search, so the two never get confused.
- Results are filtered down to actual singable songs — no hour-long
  compilations or 24/7 radio streams.
- Songs are matched to what's playable where you are, so a song queued in one
  country doesn't come up blocked for the room. Videos that genuinely can't be
  embedded are skipped automatically.

### 🎶 Lyrics

- **Swipe the now-playing card** to flip from the controls to the **lyrics**
  (swipe back, or tap the dots).
- Time-synced lyrics **highlight the current line** as the song plays. Songs
  without timing show as scrollable text.
- A **−/+ sync nudge** fixes lyrics that drift against a music video's intro,
  and your adjustment is remembered for that song next time.
- **🇯🇵 Japanese reading aid** — show **furigana** above the kanji or **romaji**
  under each line, so you can sing along to a Japanese song you can't read.
  Furigana is generated **offline** by a Japanese dictionary, so it needs no API
  key and works instantly; romaji still uses the AI key.
- **↻ Refresh with AI** re-runs whichever aids are on — the reading *and* the
  translation — for the current song. For furigana it asks the AI to correct the
  dictionary's reading rather than replace it, so a refresh can fix a wrong
  reading without losing the ones that were already right.
- **🌏 Translation** — pick a language and see what each line means under it.
- **⚐ Report** lyrics that are plainly wrong (signed-in users), and the app
  looks for a better match next time. The host screen can **↩ Restore** a
  report that was a mistake.

### 🎯 Sing & score

- Tap **🎤 Sing**, set your name, and allow mic access. The TV paints a
  scrolling **pitch ribbon** over the video with a live **score**.
- When the app knows the song's melody, the score becomes a real **melody
  match** — your trace turns green only when you're on the right note (any
  octave counts) and red when you're off it.
- **Several people can sing at once.** A live **leaderboard** ranks everyone,
  and an **end-of-song score card** crowns the winner.
- **Your mic audio never leaves your phone** — only the notes you hit are sent
  to the TV.
- Scoring works best on vocal-forward songs; dense arrangements are noisier.

### 🎉 Reactions & party extras

- A floating button opens a panel with **sound effects** — applause, whistle,
  airhorn, ta-da, drumroll, sad trombone — that play on the TV, one at a time.
- **🎡 Random singer wheel** — a shared list of names (seeded from whoever has
  songs queued) that **spins on the TV** for the whole room to watch, with a
  drumroll and applause, and lands on who's up next. Anyone can start the spin
  and every phone sees the same wheel.
- **★ Favourites** (signed-in) sortable by newest or how often you've sung
  them, plus **🎲 Random favourite** to queue a starred song in one tap.
  **Recent** is each room's own play history.
- **⚙ Settings** holds your per-device preferences — the reading aid,
  translation language and the target-line toggle.

---

## Good to know

- **Any modern browser works.** No install on any device.
- **Keep the host tab in the foreground.** Browsers pause video when you switch
  away from the tab, which pauses the room.
- **The mic needs a secure page.** Phone browsers only grant mic access over
  `https` (or on `localhost`), so sing-to-score needs the app served over
  HTTPS.
- **Rooms are temporary.** The queue and now-playing state live only as long as
  the party; favourites are the part that's kept.
- **The password matters.** Guests need the room code *and* the password, and so
  does a second TV joining the same room.

---

## Run your own copy

You'll need **Node 20+**, **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on
your `PATH` for search, and optionally **ffmpeg** for melody scoring.

```bash
cp .env.local.example .env.local   # fill in the values you want
npm install
npm run dev                        # http://localhost:3000
```

Open the host screen on a laptop and the remote on a phone on the same Wi-Fi via
your machine's LAN address (e.g. `http://192.168.1.50:3000`) — add that origin to
`allowedDevOrigins` in `next.config.ts` first. The QR code on the host screen
links to the remote.

### Configuration

Everything goes in `.env.local`. All of it is optional except where noted —
the app runs with an empty file, just with fewer features.

| Variable | What it enables |
| --- | --- |
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL` | Google sign-in and personal favourites. `AUTH_URL` must be your public origin — **required** if you're behind a proxy or tunnel. |
| `YOUTUBE_API_KEY` | Metadata for pasted links, chart-based top hits, and a search fallback. |
| `RAPIDAPI_KEY` | A second lyrics source for songs the free one doesn't have. |
| `ORCAROUTER_API_KEY` | The AI features (Ask AI, romaji, translation — furigana runs offline and needs no key). **Server-side only — never prefix it with `NEXT_PUBLIC_`.** Users can also bring their own key in ⚙ Settings. |

See the comments in `.env.local.example` for the rest, and don't commit
`.env.local`.

### Tests

```bash
npm test           # run once
npm run test:watch # watch mode
```

CI runs the type-checker and the full suite on every pull request and every push
to `main`; images are only built and deployed after those pass.

### Deploying

Two supported shapes:

- **Kubernetes** — a single-replica Deployment behind your own TLS reverse
  proxy. See **[k8s/README.md](k8s/README.md)**.
- **A single small VM** — run the server under systemd (see
  [`deploy/`](deploy/)) behind Caddy or nginx with WebSocket upgrade headers.

Either way it's one long-lived Node process: real-time sync needs a persistent
WebSocket connection, which serverless platforms can't hold open.

---

## License

See [LICENSE](LICENSE).
