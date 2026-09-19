#!/usr/bin/env bash
# One-time installer for the Moviegram sync host (Oracle Cloud Always Free VM,
# any small VPS, or a spare machine). Installs Node + cloudflared, fetches the
# repo, installs production deps and registers a systemd service that keeps the
# sync server + tunnel alive across reboots.
#
# Usage (on the host, as a sudo-capable user):
#   curl -fsSL <raw-installer-url> | bash
#   # or: git clone <repo> && bash scripts/install-sync-host.sh
#
# Then create .env.local from the printed template and:
#   sudo systemctl restart moviegram-sync && journalctl -u moviegram-sync -f
set -euo pipefail

APP_DIR="${MOVIEGRAM_DIR:-$HOME/moviegram}"
SERVICE=moviegram-sync
NODE_MAJOR=22

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "System packages"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates git ffmpeg
else
  echo "Non-Debian host: install curl, git and ffmpeg yourself, then re-run." >&2
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  say "Installing Node $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  say "Installing cloudflared"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) CF=cloudflared-linux-amd64 ;;
    aarch64|arm64) CF=cloudflared-linux-arm64 ;;
    *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
  esac
  sudo curl -fsSL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF"
  sudo chmod +x /usr/local/bin/cloudflared
fi

if [ ! -d "$APP_DIR/.git" ]; then
  say "Fetching the app into $APP_DIR"
  echo "Clone your repo there first (git clone <your-repo> $APP_DIR) or copy the"
  echo "folder over, then re-run this installer." >&2
  exit 1
fi

say "Production dependencies"
cd "$APP_DIR"
npm ci --omit=dev

say "systemd service ($SERVICE)"
sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=Moviegram sync server (WebSocket + video streaming)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
Environment=WS_PORT=3001
Environment=NODE_ENV=production
ExecStart=/bin/bash $APP_DIR/scripts/sync-host.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"

cat <<EOF

$(say "Almost done")

Create the environment file:

  cat > $APP_DIR/.env.local <<'ENV'
  DATABASE_URL=postgresql://...        # same Neon URL as Vercel
  SESSION_SECRET=...                   # same secret as Vercel
  TELEGRAM_API_ID=...
  TELEGRAM_API_HASH=...
  TELEGRAM_SESSION=...
  ENV

Then start it and watch the URL it advertises:

  sudo systemctl restart $SERVICE
  journalctl -u $SERVICE -f

No inbound ports needed: the tunnel is outbound-only, so Oracle's default
iptables/security lists can stay closed.

EOF
