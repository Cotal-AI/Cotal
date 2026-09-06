#!/bin/sh
# Shared seat pack proof: assemble native linux-x64 + linux-arm64 helpers, then
# `pnpm pack` that tree. Does not compile. Does not run `pnpm build`.
set -eu
repo="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$repo"
x64="${SEAT_NATIVE_X64:?SEAT_NATIVE_X64 is required (linux-x64 peercred.node from the native builder)}"
arm64="${SEAT_NATIVE_ARM64:?SEAT_NATIVE_ARM64 is required (linux-arm64 peercred.node from the native builder)}"
dest="${SEAT_PACK_DEST:?SEAT_PACK_DEST is required}"
node "$repo/scripts/seat-assemble-natives.mjs" --x64 "$x64" --arm64 "$arm64"
mkdir -p "$dest"
pnpm --filter @cotal-ai/seat pack --pack-destination "$dest"
tarball="$(find "$dest" -maxdepth 1 -name '*.tgz' | head -n 1)"
test -n "$tarball" || { echo "no tarball from pnpm pack"; exit 2; }
host="$(uname -m)"
test -n "$host" || { echo "host computation was empty"; exit 2; }
platform_arch="$(node -p 'process.platform + "-" + process.arch')"
test -n "$platform_arch" || { echo "platform-arch computation was empty"; exit 2; }
echo "host=$host"
echo "platform-arch=$platform_arch"
echo "tarball=$tarball"
echo -n "pack_sha256="
sha256sum "$tarball"
tar -tzf "$tarball" | grep -E 'peercred|build/' || true
if tar -tzf "$tarball" | grep -qx "package/build/Release/peercred.node"; then
  echo "unkeyed peercred.node must not ship"
  exit 2
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/extracted"
tar -xzf "$tarball" -C "$tmp/extracted"
test -d "$tmp/extracted/package" || { echo "tarball missing package/"; exit 2; }
node "$repo/packages/seat/scripts/assert-shipped-natives.mjs" "$tmp/extracted/package"
file "$tmp/extracted/package/build/Release/linux-x64/peercred.node"
file "$tmp/extracted/package/build/Release/linux-arm64/peercred.node"
readelf -h "$tmp/extracted/package/build/Release/linux-x64/peercred.node" | grep -E 'Machine|Class'
readelf -h "$tmp/extracted/package/build/Release/linux-arm64/peercred.node" | grep -E 'Machine|Class'
