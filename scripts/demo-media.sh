#!/usr/bin/env bash
# Generates the local demo media used by POC A (PRD 29 steps 5-12).
# Big Buck Bunny (CC-BY Blender Foundation) + a synthetic 120s "sync clock"
# clip with a burned-in timestamp for drift measurement.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/media

if [ ! -f public/media/big-buck-bunny.mp4 ]; then
  echo "Downloading Big Buck Bunny sample (10s, CC-BY Blender)..."
  curl -fsSL --max-time 60 -o public/media/big-buck-bunny.mp4 \
    "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4" \
    || echo "WARN: download failed — sync-clock clip below is enough for QA."
fi

if [ ! -f public/media/sync-clock.mp4 ]; then
  echo "Rendering 120s sync-clock clip with ffmpeg..."
  ffmpeg -y -loglevel error \
    -f lavfi -i "testsrc2=duration=120:size=640x360:rate=25" \
    -f lavfi -i "sine=frequency=520:duration=120" \
    -vf "drawtext=text='%{pts\:hms}':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.6:x=10:y=10" \
    -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -shortest \
    -movflags +faststart public/media/sync-clock.mp4
fi

ls -la public/media/
echo "Done. Now run: npm run db:seed"
