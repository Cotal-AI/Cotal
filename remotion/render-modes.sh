#!/usr/bin/env bash
# Render the three README delivery-mode animations to ../assets/*.webp.
# Animated WebP (not GIF) so the rounded cream cards keep crisp anti-aliased
# edges over a transparent margin and float on GitHub light or dark.
# Needs img2webp (brew install webp); remotion brings its own renderer.
set -euo pipefail
cd "$(dirname "$0")"
for pair in Multicast:multicast Unicast:unicast Anycast:anycast; do
  comp="Mode${pair%%:*}"
  name="${pair##*:}"
  rm -rf "out/seq-$name"
  # --scale=2: the docs pages show these at full column width; 2x keeps retina crisp
  npx remotion render "$comp" --sequence --image-format=png --scale=2 --concurrency=8 "out/seq-$name"
  img2webp -loop 0 -lossy -q 82 -m 6 -d 26 "out/seq-$name"/*.png -o "../assets/$name.webp"
done
