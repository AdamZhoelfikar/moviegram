<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Moviegram — agent guide

Private 2-person watch party. Product intent lives in `prd.md`, a **private,
gitignored file that is not in this repo or on GitHub** — do not commit, link,
or reference it from tracked files.

## What this is

Next.js 16 app (Vercel target) + a **separate standalone WebSocket sync server**
(`server/ws.ts`, cannot run on Vercel) + PostgreSQL (Drizzle) + Telegram MTProto
video storage via `teleproto` (the maintained GramJS fork — `telegram` npm is archived).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | one-command bootstrap for new users: `.env.local` + deps + docker postgres + db:push + demo media + seed (idempotent) |
| `npm run dev:all` | dev loop in one terminal (Turbopack :3000 + ws :3001) |
| `npm run dev` + `npm run dev:ws` | the same two processes, separately |
| `docker compose up -d postgres` | local DB only (dev default) |
| `docker compose up --build` | full stack: postgres + app + ws |
| `npm run db:push` / `db:generate` / `db:migrate` | Drizzle (needs `DATABASE_URL`) |
| `npm run media:demo` | generate `public/media/*.mp4` demo clips (ffmpeg/curl; gitignored) |
| `npm run db:seed` | demo library rows (run after media:demo) |
| `npm test` / `typecheck` / `lint` / `build` | gates — all must stay green |
| `npm run telegram:login -- <phone>` | mint `TELEGRAM_SESSION` (interactive) |
| `npm run import:telegram -- <channel>` | import channel videos into library |

## Next 16 rules that bite

- `params`, `searchParams`, `cookies()`, `headers()` are **async** — always `await`.
- Route handlers live in `app/**/route.ts`; they are dynamic by default (no config needed).
- `middleware` is renamed `proxy` — this app deliberately uses neither; auth is checked
  in handlers/pages via `lib/session.ts`.
- Turbopack is the default dev+build bundler. Server-only npm packages that break when
  bundled go in `serverExternalPackages` in `next.config.ts`. `teleproto` must stay
  **out** of it (its subpath imports fail Node resolution in standalone traces).
- React Compiler–era lint rules are enabled (`eslint-config-next`): no impure calls
  (`Date.now()`) directly in component bodies (use a module-level helper), no ref writes
  during render, no synchronous `setState` in effect bodies (defer with
  `queueMicrotask`/promise continuation or restructure).
- `.next/standalone` server needs `public/` and `.next/static` copied in — the Dockerfile
  and `scripts/` helpers do this; a bare `node .next/standalone/server.js` from repo root
  will 404 media otherwise.

## Architecture invariants (do not regress)

- **One room = one authoritative timeline.** The ws server stamps every state change with
  its wall clock (`serverTsMs`); clients derive `expectedPosition` from it. Never let a
  client be the source of truth.
- In-memory room state in `server/room-registry.ts` is a **cache**; Postgres is the truth.
  Playback state is persisted on every control event and flushed periodically, and rooms
  are re-hydrated on demand (restart-safe). Keep it that way.
- Only the host may send play/pause/seek/change_video/ended — enforced **server-side**,
  not just in the UI.
- Browsers must never learn Telegram identifiers: `videos.telegram_*` stays server-side;
  the only video path to the client is the sync host's `/stream/[videoId]?grant=…`
  (short-lived HMAC) or a `url` redirect for demo assets.
- **Telegram MTProto runs in exactly one process — never on Vercel.** Telegram
  invalidates an auth key used concurrently from two connections
  (`AuthKeyDuplicatedError`), and serverless instances are neither single nor
  long-lived. Video bytes are served by `server/streamer.ts` on the sync-server
  host; `app/api/stream/[videoId]` is a thin redirector for `url` sources only.
  Never import `lib/telegram.ts` from `app/` — it would put teleproto (~2 MB)
  back into every Vercel function and risk a second session.
- The sync host **publishes its own URL** to the `settings` table
  (`lib/sync-host.ts`, heartbeat every 30 s) and `app/r/[code]` reads it at
  request time. That is why moving the host (new VPS, rotated tunnel URL) needs
  no Vercel rebuild. A heartbeat older than 90 s counts as offline and the room
  shows a warning instead of failing silently.
- WS auth uses short-lived signed **tickets** returned by `POST /api/rooms/[code]/join`
  (session cookie is httpOnly and cannot be read by JS). Reconnects reuse the cached
  ticket; only a `forbidden` error forces a fresh join call. Do not reconnect through
  REST on every retry (rate-limit storm).
- Room roster is re-synced from Postgres on every WS connect (REST join and WS join are
  different processes).
- Sync thresholds live in `lib/sync.ts` (`DEFAULT_THRESHOLDS`) and are unit-tested.
  Drift <100 ms ignore, ≤500 ms playbackRate nudge, >500 ms hard seek.

## Gotchas learned the hard way

- `pkill -f "server.js"` also matches VS Code's `tsserver.js` — match precisely or kill by
  port via `ss -ltnp`.
- tsx runs files outside the project as CJS → no top-level await in `/tmp` scripts;
  project `scripts/*.ts` are fine.
- Telegram `file_reference` values expire — every stream request re-resolves the message
  (`lib/telegram.ts`), and MP4s need `+faststart` for browser seeking.
- `docker compose` env: `NEXT_PUBLIC_*` is baked at image **build** time (ARG in
  `Dockerfile`), not runtime.
- Demo media is gitignored; regenerate with `npm run media:demo` before seeding/playing.
- Vercel cost rules: keep DB work cached (`lib/video-cache.ts`), keep the pool at
  `max: 1` with `prepare: false` (Neon pooler), and never stream bytes through a
  function — a stalled stream holds a function until `maxDuration` (300 s timeouts
  were observed before streaming moved to the sync host).
- tsx does **not** auto-load `.env.local` (Next does). All tsx invocations pass
  `--env-file-if-exists=.env.local` — without it the ws server falls back to the dev
  `SESSION_SECRET` in `lib/env.ts` while the app signs tickets with the `.env.local`
  value, and joins fail HMAC verification. Keep the flag on any new tsx script.

## Verification loop

`npm run typecheck && npm test && npm run lint && npm run build`, then for anything
touching sync/ws: run both servers and exercise two browser tabs (Playwright MCP:
login Adam → create room from library → new tab → login Friend → join → play/pause/seek
→ compare `video.currentTime` across tabs; reload the guest mid-play to prove resync).
