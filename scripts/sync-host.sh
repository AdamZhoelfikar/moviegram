#!/usr/bin/env bash
# Supervises the sync server (WebSocket + video streaming) behind a Cloudflare
# quick tunnel.
#
# Why a supervisor: quick tunnels can be dropped server-side
# ("Unauthorized: Tunnel not found") and cloudflared then retries the same dead
# tunnel forever. This loop restarts it, which mints a NEW hostname; the sync
# server reads the live hostname from cloudflared's metrics endpoint and
# republishes it to Postgres (lib/sync-host.ts), so the Vercel app follows
# automatically — no rebuild, no manual URL update.
#
# Used by systemd (deploy/moviegram-sync.service); safe to run by hand.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${WS_PORT:-3001}"
METRICS_PORT="${CLOUDFLARED_METRICS_PORT:-20241}"
LOG_DIR="${MOVIEGRAM_LOG_DIR:-$HOME/.cache/moviegram}"
mkdir -p "$LOG_DIR"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

CF_PID=""
WS_PID=""
cleanup() {
  [ -n "$WS_PID" ] && kill "$WS_PID" 2>/dev/null
  [ -n "$CF_PID" ] && kill "$CF_PID" 2>/dev/null
}
trap 'cleanup; exit 0' INT TERM

tunnel_hostname() {
  curl -s --max-time 2 "http://127.0.0.1:${METRICS_PORT}/quicktunnel" 2>/dev/null |
    grep -oE '"hostname":"[^"]+"' | cut -d'"' -f4
}

while true; do
  : > "$TUNNEL_LOG"
  echo "[sync-host] starting cloudflared (metrics :$METRICS_PORT)"
  cloudflared tunnel --url "http://localhost:${PORT}" --no-autoupdate \
    --metrics "127.0.0.1:${METRICS_PORT}" >> "$TUNNEL_LOG" 2>&1 &
  CF_PID=$!

  HOST=""
  for _ in $(seq 1 60); do
    HOST=$(tunnel_hostname)
    [ -n "$HOST" ] && break
    if ! kill -0 "$CF_PID" 2>/dev/null; then
      echo "[sync-host] cloudflared exited early" >&2
      break
    fi
    sleep 1
  done

  if [ -n "$HOST" ]; then
    echo "[sync-host] tunnel up: https://$HOST"
    # PUBLIC_WS_URL is intentionally NOT set: the server discovers the live
    # hostname itself, so a rotated tunnel is picked up without a restart.
    npx tsx --env-file-if-exists=.env.local server/ws.ts &
    WS_PID=$!

    # Watch for a dropped tunnel or a dead process.
    while kill -0 "$CF_PID" 2>/dev/null && kill -0 "$WS_PID" 2>/dev/null; do
      if tail -n 40 "$TUNNEL_LOG" | grep -qE "Unauthorized: Tunnel not found|Failed to serve tunnel"; then
        echo "[sync-host] tunnel dropped by Cloudflare — recreating" >&2
        break
      fi
      sleep 15
    done
  else
    echo "[sync-host] no tunnel hostname; retrying" >&2
  fi

  cleanup
  CF_PID=""
  WS_PID=""
  sleep 5
done
