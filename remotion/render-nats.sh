#!/usr/bin/env bash
# Render the three README "on top of NATS" animations to ../assets/*.webp, in the
# same card style and encoding as render-modes.sh.
# Needs img2webp (brew install webp); remotion brings its own renderer.
set -euo pipefail
cd "$(dirname "$0")"
for pair in Identity:identity Replay:replay Attention:attention; do
  comp="Nats${pair%%:*}"
  name="${pair##*:}"
  rm -rf "out/seq-$name"
  npx remotion render "$comp" --sequence --image-format=png --scale=2 --concurrency=8 "out/seq-$name"
  img2webp -loop 0 -lossy -q 82 -m 6 -d 26 "out/seq-$name"/*.png -o "../assets/$name.webp"
done
