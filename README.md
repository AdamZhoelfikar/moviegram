# Moviegram

Private 2-person watch parties in the browser. **One room. One timeline.**
Play, pause and seek stay synchronized between you and one friend — measured
at tens of milliseconds in local testing, not "both happen to be playing the
same movie".

Watch **your own movies**: videos are stored in a private Telegram channel and
streamed straight into the synced player (MTProto, nothing uploaded to any
third-party server). A few CC-licensed demo clips are included to try the sync
first — see [Full mode](#full-mode--watch-your-own-movies) to use your own
library.

---

## Install in one command

Requirements: **Node 22+** and **Docker** (ffmpeg optional, only for demo clips).

```bash
npm run setup      # env file + deps + postgres + schema + seed — idempotent
npm run dev:all    # app on :3000 AND sync server on :3001, one terminal
```

Open `http://localhost:3000` in two windows (one incognito), enter a display
name in each, **Create Watch Room → Watch** in one, copy the invite link into
the other, **Join room**, press play. The sync pill shows 🟢/🟡/🔴 and
`↻ Sync` re-anchors manually.

On phones the room stacks the player above a **Chat / Room** tab bar, controls
use 44 px touch targets, tapping the picture shows/hides them, and the
fullscreen button locks the screen to landscape (iOS uses the native video
player). Invite links work across devices — open the same URL on a phone.

<details>
<summary>Manual setup (if you prefer, or no Docker)</summary>

```bash
cp .env.example .env.local          # defaults work against local docker postgres
docker compose up -d postgres       # or point DATABASE_URL at any Postgres
npm install
npm run media:demo                  # optional: generates public/media/*.mp4
npm run db:push
npm run db:seed
npm run dev                         # app on :3000      (terminal 1)
npm run dev:ws                      # sync server :3001 (terminal 2)
```

Full container mode: `docker compose up --build` (postgres + app + ws).
`NEXT_PUBLIC_WS_URL` is a **build arg** in that mode (baked at image build).

</details>

## Full mode — watch your own movies

The demo clips are just for trying the sync. The real product streams **your
own library** from a private Telegram channel — everything else (rooms, chat,
series/auto-next, cinema mode, history) works identically:

1. Upload the videos you have rights to store into a **private Telegram
   channel** (MP4 with `+faststart` seeks properly in the player).
2. Create an API token at <https://my.telegram.org> → set `TELEGRAM_API_ID`
   and `TELEGRAM_API_HASH` in `.env.local`.
3. `npm run telegram:login -- <phone>` → it prints a `TELEGRAM_SESSION=…`
   line → paste it into `.env.local` (stays server-side, never committed).
4. `npm run import:telegram -- @yourchannel` (or the numeric ID of a
   **private** channel, e.g. `-1001234567890` — get it by forwarding one
   post from the channel to @userinfobot). Every video lands in your
   Moviegram library with title/metadata; bytes are fetched lazily over
   MTProto at play time via the signed `/api/stream` route. Re-run the
   import any time — already-imported videos are skipped.

That's it — no re-uploading anywhere else, no 20 MB Bot API limit (MTProto is
used deliberately), and expired Telegram `file_reference`s re-resolve
automatically.

**Which files actually play in the browser:** the player uses native HTML5
`<video>`, so upload **H.264/AVC MP4 with `+faststart`** for universal
playback. HEVC/H.265 (`x265`/`hevc_nvenc` rips) only decodes on Safari and
HEVC-hardware Edge — elsewhere you'll hear audio over a black picture, and
the player now shows an explicit banner saying so. Fix an existing rip with:

```bash
ffmpeg -i in.mp4 -c:v h264_nvenc -preset p2 -cq 23 -c:a copy \
  -movflags +faststart out.mp4   # or -c:v libx264 -crf 22 -preset fast
```

## Feature status

| Area | Status |
| --- | --- |
| Player sync (play/pause/seek/join-in-progress/drift correction/reconnect) | ✅ **Built & browser-verified** (two-tab Playwright QA, see [QA evidence](#tests--qa-evidence)) |
| Telegram MTProto chunk streaming → HTML5 video with seeking | ✅ **Built & browser-verified** with a live private channel (pipelined 512 KB chunks; throughput is connection-bound, ~1 MB/s measured) |
| Landing, library, rooms, invite, 2-person limit, host system, sync status, basic identity | ✅ Built |
| Chat + timestamps, reactions, watch history/continue, subtitles track, series/episodes + auto-next, cinema mode, room expiration | ✅ Built (minimal versions) |
| Queue, watchlist, password rooms, admin UI, stricter buffering policy | ⏳ Not built — deliberate lean-build scope cut |
| Casting, multi-audio, multi-instance scale | ⏳ Out of scope |

## Architecture

```
            ┌───────────────────────────┐        ┌──────────────────────────────┐
 browser ◄──┤  Next.js 16 (Vercel)      │        │  Sync server (server/ws.ts)  │
 browser ◄──┤  pages + REST API         │◄──────►│  standalone Node + `ws`      │
            │  /api/stream = range video│ tickets│  authoritative room state    │
            └────────────┬──────────────┘        └──────────────┬───────────────┘
                         │                                      │
                    ┌────▼─────────────────────────────────────▼────┐      ┌────────────┐
                    │                 PostgreSQL (Drizzle)            │◄────►│  Telegram  │
                    │  users videos rooms room_members messages hist  │ MTProto│  (files)  │
                    └──────────────────────────────────────────────────┘      └────────────
```

- **Why a separate WS process?** Vercel cannot host long-lived sockets. The sync
  server is a tiny standalone Node process (`Dockerfile.ws`) deployable to any
  container host (Railway/Fly/a VPS); it holds live room state, stamps every
  event with its own wall clock, persists playback state to Postgres on every
  control event + periodic flush, and re-hydrates rooms from the DB — so a
  restart never loses the timeline.
- **Video bytes never touch Vercel.** Browsers get either a redirect (demo `url`
  sources) or the range-capable `/stream/[videoId]` endpoint on the **sync
  server host**, which pulls byte ranges from Telegram via MTProto
  `upload.getFile` chunks (teleproto) and re-exposes them with correct
  `206/Content-Range` semantics. Telegram ids are never sent to the client.
  Keeping the single MTProto connection in one process is what keeps the
  session valid — Telegram invalidates an auth key used concurrently from two
  connections, and serverless instances are neither single nor long-lived.

### Sync model

Server state per room: `{ videoId, playing, positionSeconds, playbackRate, serverTsMs }`.

Clients ping every 5 s (`ping/pong`) to estimate `clockOffset = serverTime −
localTime` (smoothed), then compute
`expectedPosition = position + (serverNow − serverTs) × rate` and compare with
the local `video.currentTime`:

| drift | action (`lib/sync.ts`, unit-tested) |
| --- | --- |
| < 100 ms | ignore |
| 100–500 ms | gradual `playbackRate` nudge (±5 %), restored after 2.5 s |
| > 500 ms | hard seek to expected position |

Host-only controls (`play/pause/seek/change_video/ended`) are enforced **on the
server**; the guest UI additionally disables them. Reconnects use exponential
backoff and re-fetch authoritative state — no page refresh needed.

### Realtime protocol

JSON over `ws://<sync-server>/?code=<invite>&token=<ticket>` — client:
`ping play pause seek sync ended change_video chat reaction leave`;
server: `pong joined state stream chat_message reaction room_ended error`.
Tickets are short-lived HMAC payloads issued by `POST /api/rooms/[code]/join`
because the httpOnly session cookie cannot be read by `WebSocket`.

## Environment variables

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection |
| `SESSION_SECRET` | HMAC key for sessions/grants/tickets — **required in production** |
| `NEXT_PUBLIC_WS_URL` | browser → sync server URL (default `ws://localhost:3001`); its origin also serves `/stream/...` |
| `WS_PORT` | sync server port |
| `PUBLIC_STREAM_BASE` | optional: override the video-byte origin when it differs from the WS host |
| `ROOM_TTL_HOURS` | room expiry (default 168 = 7 days) |
| `STREAM_TOKEN_TTL_HOURS` | stream grant lifetime (default 12) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` | MTProto credentials |
| `TELEGRAM_IMPORT_CHANNEL` | default channel for `import:telegram` |
| `TELEGRAM_CHUNK_KB` | MTProto chunk size (default 512) |

## Project layout

```
app/            pages (/, /library, /r/[code]) + api/ (auth, rooms, videos, history, stream)
components/     video/ (player+sync loop), room/ (RoomClient, chat UI…), chat/, home/, auth/
lib/            sync.ts (pure math), protocol.ts, telegram.ts, range.ts, auth.ts, db.ts, …
server/         ws.ts + room-registry.ts (authoritative live state)
db/             schema.ts + migrations/
scripts/        seed, demo-media, import-telegram, telegram-login
Dockerfile / Dockerfile.ws / docker-compose.yml
```

## Tests & QA evidence

- `npm test` — 26 unit tests: clock offset, expected position, drift
  thresholds/corrections, connection classification, range parsing, session
  tokens, stream grants, WS tickets.
- Browser QA (Playwright MCP, two tabs, local stack):
  - host play → guest followed within **~30 ms** measured across tabs;
  - guest **reload mid-play** → auto-resync to **~80 ms** (target <100 ms);
  - host seek/pause → guest follows; room end → `ended` → both consistent;
  - third user joining → `409 "This room already has two participants."`;
  - timestamped chat + reactions delivered live across tabs;
  - sync-server **restart mid-room** → state re-hydrated from Postgres;
  - cinema mode, invite copy, fullscreen controls verified via screenshots.
- Telegram streaming: browser-verified end-to-end (play + arbitrary-offset
  seek, no range errors); the code path, range math and grant auth are also
  unit-tested.

## Deployment

- **App (Vercel):** standard Next.js deploy; set `DATABASE_URL`,
  `SESSION_SECRET`, `NEXT_PUBLIC_WS_URL` (pointing at your sync host). Vercel
  only serves pages + JSON APIs: `url` sources redirect, Telegram video bytes
  are served by the sync host, and `app/api/stream` never touches Telegram.
- **Sync server:** any persistent Node host: `docker build -f Dockerfile.ws .`
  or `npm ci && npm run ws`. Needs `DATABASE_URL` + `SESSION_SECRET` (same
  secret as the app) and the `TELEGRAM_*` credentials — it is the only process
  that talks MTProto, which is what keeps the session valid. Quick-and-free
  from a home machine: run `npm run ws` and expose it with
  `cloudflared tunnel --url http://localhost:3001`, then set
  `NEXT_PUBLIC_WS_URL=wss://<tunnel-host>` in Vercel and redeploy (the URL
  changes whenever the tunnel restarts; the stream URL follows it).
- **DB:** managed Postgres (Neon/Supabase/RDS); run `npm run db:migrate`.
- Rate limiting is in-process (single instance assumed — fine for 2 users;
  revisit with Redis only if you scale).

### Always-on sync host (no laptop required)

The sync server is the only process that talks to Telegram (one MTProto
session) and it serves the video bytes, so while it runs on your laptop,
closing the laptop stops playback and syncing. Move it to any always-on box —
the app keeps working because the host **publishes its own URL** to the
`settings` table and the room page reads it at request time (no Vercel rebuild
when the host moves or the tunnel URL rotates).

**Free option: Render (Singapore, no card).** `render.yaml` in this repo is a
ready Blueprint:

1. Push this repo to GitHub (already done if you're reading this in the repo).
2. [render.com](https://render.com) → sign up with GitHub → **New → Blueprint**
   → pick this repository. Render reads `render.yaml`, builds `Dockerfile.ws`
   and asks for the five secrets: `DATABASE_URL` (your Neon URL),
   `SESSION_SECRET` (same as Vercel), `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
   `TELEGRAM_SESSION` (copy them from your local `.env.local`).
3. Deploy. The service URL is stable
   (`https://moviegram-sync.onrender.com`) and the server publishes it to
   Postgres by itself — nothing to configure on Vercel.
4. Keep it awake: free instances spin down after 15 minutes without traffic
   (~1 minute to wake). This repo ships a GitHub Actions pinger
   (`.github/workflows/keep-sync-host-awake.yml`) that hits `/health` every
   5 minutes — it needs no signup and works out of the box. For a stricter
   schedule, point any free pinger ([cron-job.org](https://cron-job.org),
   UptimeRobot) at `https://moviegram-sync.onrender.com/health`. While a room
   is open the WebSocket traffic already keeps it alive.

Free plan limits to know: 0.1 CPU / 512 MB, 750 instance-hours per month
(a 24/7 pinger uses ~730), 100 GB outbound bandwidth, and Render may restart
the instance at any time. Two hosts can run at once safely — only the first
claims the slot, and the other takes over within 90 s if it stops (see
`lib/sync-host.ts`).

**Alternative: any VPS** (Oracle Always Free, Hetzner, …) with the installer:

```bash
git clone <your-repo> ~/moviegram && cd ~/moviegram
bash scripts/install-sync-host.sh          # Node, cloudflared, deps, systemd
$EDITOR .env.local                         # DATABASE_URL, SESSION_SECRET, TELEGRAM_*
sudo systemctl start moviegram-sync
journalctl -u moviegram-sync -f            # shows the advertised URL
```

No inbound ports or security-list changes are needed — the tunnel is
outbound-only. `scripts/sync-host.sh` supervises both the tunnel and the
server: if Cloudflare drops the quick tunnel (`Unauthorized: Tunnel not
found`) it is recreated and the new URL is republished automatically.

## Known limitations (honest list)

- Strict "wait-for-both" buffering policy is simplified: a
  buffering peer is corrected after it catches up, the room does not auto-pause.
- One active room per pair at a time is the tested path; multiple concurrent
  rooms work but were not load-verified.
- No password rooms, queue, watchlist, admin UI, multi-audio.
- `watch history` writes attribute to the current cookie's user (fine for the
  2-person product; revisit with real auth).
- Telegram streaming is verified against a live private channel; throughput
  per stream is bounded by the server's connection to Telegram's media DC
  (~1 MB/s measured) — plenty for 720p/1080p with normal buffering.

## Agent / contributor docs

See [`AGENTS.md`](./AGENTS.md) — Next 16 breaking-change rules, architecture
invariants, commands, and the gotchas that cost real debugging time.

## License / content rights

Private-use project. Only store/stream content you are authorized to.
Demo media: Big Buck Bunny © Blender Foundation (CC-BY 3.0),
generated locally; the sync-clock clip is synthetic.
