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
echo "host=$(uname -m)"
echo "platform-arch=$(node -p 'process.platform + \"-\" + process.arch')"
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
tar -xOf "$tarball" package/build/Release/linux-x64/peercred.node > "$tmp/x64.node"
tar -xOf "$tarball" package/build/Release/linux-arm64/peercred.node > "$tmp/arm64.node"
file "$tmp/x64.node"
file "$tmp/arm64.node"
readelf -h "$tmp/x64.node" | grep -E 'Machine|Class'
readelf -h "$tmp/arm64.node" | grep -E 'Machine|Class'
node --input-type=module - "$tmp/x64.node" "$tmp/arm64.node" <<'EOF'
import { readFileSync } from "node:fs";
const machine = (p) => {
  const b = readFileSync(p);
  if (b.length < 20 || b[0] !== 0x7f || b.subarray(1, 4).toString("ascii") !== "ELF") {
    throw new Error(`${p} is not ELF`);
  }
  return b.readUInt16LE(18);
};
const x64 = machine(process.argv[1]);
const arm = machine(process.argv[2]);
console.log(`pack_elf_x64=${x64} pack_elf_arm64=${arm}`);
if (x64 !== 62 || arm !== 183) {
  throw new Error("packed helpers are not linux-x64 EM_X86_64 plus linux-arm64 EM_AARCH64");
}
EOF
