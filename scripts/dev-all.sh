#!/usr/bin/env bash
# Runs the Next app (:3000) and the WebSocket sync server (:3001) together,
# so development needs one terminal instead of two. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

trap 'kill 0' EXIT INT TERM

npm run dev:ws &
npm run dev &

wait
