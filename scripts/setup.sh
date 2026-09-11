#!/usr/bin/env bash
# One-command bootstrap: fresh clone -> ready to run.
# Safe to re-run; it never overwrites an existing .env.local.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "ERROR: Node 22 or newer is required (found: $(node -v 2>/dev/null || echo 'none'))." >&2
  echo "Get it from https://nodejs.org or: nvm install --lts" >&2
  exit 1
fi

if [ ! -f .env.local ]; then
  say "Creating .env.local from .env.example"
  cp .env.example .env.local
  echo "Edit .env.local any time — defaults work for local development."
else
  say ".env.local already exists — leaving it untouched"
fi

say "Installing dependencies"
npm install

if command -v docker >/dev/null 2>&1; then
  say "Starting local PostgreSQL via Docker"
  docker compose up -d postgres
  printf "  waiting for postgres "
  for _ in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U wp -d wp >/dev/null 2>&1; then break; fi
    printf "."
    sleep 1
  done
  echo " ready"
else
  say "Docker not found — skipping local Postgres."
  echo "  Make sure DATABASE_URL in .env.local points to a running Postgres."
fi

say "Pushing database schema"
npm run db:push

if command -v ffmpeg >/dev/null 2>&1; then
  say "Generating demo media (public/media/*.mp4)"
  npm run media:demo
else
  say "ffmpeg not found — skipping demo media. Demo clips won't play, but"
  echo "  your own Telegram library (see README 'Full mode') works without it."
fi

say "Seeding the demo library rows"
npm run db:seed

cat <<'EOT'

Done. Two options from here:

  npm run dev:all                 # app :3000 + sync server :3001, one terminal
  open http://localhost:3000      # in two windows (one incognito) -> create room,
                                  # copy the invite link into the other, press play.

Want to watch your own movies instead of the demo clips?
Set TELEGRAM_API_ID/TELEGRAM_API_HASH in .env.local, then:

  npm run telegram:login -- <your-phone>     # paste the printed session key into .env.local
  npm run import:telegram -- @yourchannel    # videos appear in the library

EOT
