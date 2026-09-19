#!/usr/bin/env bash
# Runs the sync server (WebSocket + video streaming) behind a Cloudflare
# quick tunnel. Prints the public URL into the log and exports PUBLIC_WS_URL so
# the server publishes itself to Postgres (lib/sync-host.ts) — the Vercel app
# then discovers the host at request time, no rebuild needed.
#
# Used by systemd (deploy/moviegram-sync.service); safe to run by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="${MOVIEGRAM_LOG_DIR:-$HOME/.cache/moviegram}"
mkdir -p "$LOG_DIR"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
: > "$TUNNEL_LOG"

cleanup() {
  if [ -n "${TUNNEL_PID:-}" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

cloudflared tunnel --url "http://localhost:${WS_PORT:-3001}" --no-autoupdate \
  > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# The quick-tunnel hostname appears in the log a few seconds after start.
PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  [ -n "$PUBLIC_URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "[sync-host] cloudflared exited early:" >&2
    cat "$TUNNEL_LOG" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "[sync-host] could not detect the tunnel URL" >&2
  exit 1
fi

# wss:// for the WebSocket, https:// for the /stream/ bytes — same origin.
export PUBLIC_WS_URL="${PUBLIC_URL/https:/wss:}"
export PUBLIC_STREAM_BASE="$PUBLIC_URL"
echo "[sync-host] public url: $PUBLIC_WS_URL"

exec npx tsx --env-file-if-exists=.env.local server/ws.ts
