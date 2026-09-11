# Moviegram

Private 2-person watch parties in the browser. **One room. One timeline.**
Play, pause and seek stay synchronized between you and one friend — measured
at tens of milliseconds in local testing, not "both happen to be playing the
same movie".

Built from [`prd.md`](./prd.md) — that file is the product source of truth;
this README documents the implementation and its status.

---

## Status against the PRD

| PRD phase | Status |
| --- | --- |
| **Phase 0 — POC A** (local player sync: play/pause/seek/join-in-progress/drift correction/reconnect) | ✅ **Built & browser-verified** (two-tab Playwright QA, see [QA evidence](#qa-evidence)) |
| **Phase 0 — POC B** (Telegram MTProto chunk streaming → HTML5 video with seeking) | 🟡 **Code complete** (`lib/telegram.ts`, `/api/stream`), needs real `TELEGRAM_*` credentials + a channel to run the final playback proof |
| **Phase 1 — MVP** (landing, library, rooms, invite, 2-person limit, host system, sync, reconnection, sync status, basic identity) | ✅ Built |
| **Phase 2** (chat, timestamped chat, reactions, watch history/continue, subtitles track, series/episodes + auto-next, cinema mode, room expiration) | ✅ Built (minimal versions) |
| Phase 2 extras (queue, watchlist, password rooms, admin UI, better buffering policy) | ⏳ Not built — deliberate lean-build scope cut |
| Phase 3/4 (casting, multi-audio, scale) | ⏳ Out of scope per PRD |

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
  restart never loses the timeline (PRD §10).
- **Video bytes never touch the sync server.** Browsers get either a redirect
  (demo `url` sources) or the range-capable `/api/stream/[videoId]` endpoint,
  which pulls byte ranges from Telegram via MTProto `upload.getFile` chunks
  (teleproto `iterDownload`) and re-exposes them with correct `206/Content-Range`
  semantics. Telegram ids are never sent to the client (PRD §16.1).

### Sync model (PRD §11)

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
backoff and re-fetch authoritative state — no page refresh needed (PRD §6.16).

### Realtime protocol (PRD §6.17)

JSON over `ws://<sync-server>/?code=<invite>&token=<ticket>` — client:
`ping play pause seek sync ended change_video chat reaction leave`;
server: `pong joined state stream chat_message reaction room_ended error`.
Tickets are short-lived HMAC payloads issued by `POST /api/rooms/[code]/join`
because the httpOnly session cookie cannot be read by `WebSocket`.

## Quick start

Requirements: Node 20.9+ (22+/26 fine), Docker, ffmpeg (only for demo media).

```bash
cp .env.example .env.local          # defaults work against local docker postgres
docker compose up -d postgres
npm install

npm run media:demo                  # generates public/media/*.mp4 (gitignored)
npm run db:push                     # or: db:generate + db:migrate
npm run db:seed                     # demo library rows

npm run dev                         # app on :3000
npm run dev:ws                      # sync server on :3001   (run in a 2nd terminal)
```

Open `http://localhost:3000` in two windows (one incognito), enter a display
name each, **Create Watch Room → Watch** in one, copy the invite link into the
other, **Join room**, press play. The sync pill shows 🟢/🟡/🔴 and `↻ Sync`
re-anchors manually.

Full container mode: `docker compose up --build` (postgres + app + ws).
`NEXT_PUBLIC_WS_URL` is a **build arg** in that mode (baked at image build).

## Telegram setup (POC B / real library)

1. Upload permitted videos to a **private Telegram channel**.
2. Get `api_id`/`api_hash` at <https://my.telegram.org> → put in `.env.local`.
3. `npm run telegram:login -- <phone>` → prints a `TELEGRAM_SESSION=…` string →
   add to `.env.local` (server-side only, never committed).
4. `npm run import:telegram -- @yourchannel` → imports video references +
   metadata into the library (chunks are fetched lazily at stream time).

Notes: MP4s need `+faststart` for seeking; expired `file_reference`s are
re-resolved automatically; Bot API is deliberately not used (20 MB limit).

## Environment variables

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection |
| `SESSION_SECRET` | HMAC key for sessions/grants/tickets — **required in production** |
| `NEXT_PUBLIC_WS_URL` | browser → sync server URL (default `ws://localhost:3001`) |
| `WS_PORT` | sync server port |
| `ROOM_TTL_HOURS` | room expiry (default 168 = 7 days, PRD §6.29) |
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
  - guest **reload mid-play** → auto-resync to **~80 ms** (PRD target <100 ms);
  - host seek/pause → guest follows; room end → `ended` → both consistent;
  - third user joining → `409 "This room already has two participants."`;
  - timestamped chat + reactions delivered live across tabs;
  - sync-server **restart mid-room** → state re-hydrated from Postgres;
  - cinema mode, invite copy, fullscreen controls verified via screenshots.
- POC B (Telegram) runtime proof is **pending credentials** — the code path,
  range math and grant auth are unit-tested.

## Deployment

- **App (Vercel):** standard Next.js deploy; set `DATABASE_URL`,
  `SESSION_SECRET`, `NEXT_PUBLIC_WS_URL` (pointing at your sync host).
  Demo `url` sources redirect; Telegram streaming runs through `/api/stream`
  (note Vercel's function time/memory limits — for heavy use, self-host the
  app container or move streaming to the sync host; the code is structured so
  `lib/telegram.ts` can run in either).
- **Sync server:** any persistent Node host: `docker build -f Dockerfile.ws .`
  or `npm ci && npm run ws`. Needs `DATABASE_URL` + `SESSION_SECRET` (same
  secret as the app).
- **DB:** managed Postgres (Neon/Supabase/RDS); run `npm run db:migrate`.
- Rate limiting is in-process (single instance assumed — fine for 2 users;
  revisit with Redis only if you scale, PRD Phase 4).

## Known limitations (honest list)

- Strict "wait-for-both" buffering policy (PRD §6.13) is simplified: a
  buffering peer is corrected after it catches up, the room does not auto-pause.
- One active room per pair at a time is the tested path; multiple concurrent
  rooms work but were not load-verified.
- No password rooms, queue, watchlist, admin UI, multi-audio (Phase 2/3 extras).
- `watch history` writes attribute to the current cookie's user (fine for the
  2-person product; revisit with real auth).
- Telegram streaming not yet proven against live credentials (POC B checklist).

## Agent / contributor docs

See [`AGENTS.md`](./AGENTS.md) — Next 16 breaking-change rules, architecture
invariants, commands, and the gotchas that cost real debugging time.

## License / content rights

Private-use project. Only store/stream content you are authorized to
(PRD §16.7). Demo media: Big Buck Bunny © Blender Foundation (CC-BY 3.0),
generated locally; the sync-clock clip is synthetic.
