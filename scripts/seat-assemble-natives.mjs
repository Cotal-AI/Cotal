#!/usr/bin/env node
/**
 * Copy native linux-x64 and linux-arm64 SO_PEERCRED helpers into @cotal-ai/seat
 * and refuse anything that is not ELF e_machine 62 plus 183.
 *
 * The PR pack proof, Changesets publish, and snapshot publish all run this
 * script. It does not compile. It does not run `pnpm build`.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = dirname(fileURLToPath(new URL(".", import.meta.url)));
const destRoot = join(repo, "packages", "seat", "build", "Release");

function arg(flag, fallbackEnv) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallbackEnv && process.env[fallbackEnv]) return process.env[fallbackEnv];
  return undefined;
}

const x64 = arg("--x64", "SEAT_NATIVE_X64");
const arm64 = arg("--arm64", "SEAT_NATIVE_ARM64");

if (!x64 || !arm64) {
  console.error(
    `@cotal-ai/seat: linux-arm64 helper was not assembled into the publish tree. Pass --x64 and --arm64 (or SEAT_NATIVE_X64 and SEAT_NATIVE_ARM64) with the native builder artifacts before pack or publish.`,
  );
  process.exit(1);
}
if (!existsSync(x64)) {
  console.error(`@cotal-ai/seat: linux-x64 native builder artifact missing at ${x64}`);
  process.exit(1);
}
if (!existsSync(arm64)) {
  console.error(
    `@cotal-ai/seat: linux-arm64 helper was not assembled into the publish tree. Native builder artifact missing at ${arm64}`,
  );
  process.exit(1);
}

for (const [arch, src] of [
  ["x64", x64],
  ["arm64", arm64],
]) {
  const dir = join(destRoot, `linux-${arch}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, "peercred.node"));
}

const assert = spawnSync(process.execPath, [join(repo, "packages", "seat", "scripts", "assert-shipped-natives.mjs")], {
  cwd: repo,
  encoding: "utf8",
});
if (assert.stdout) process.stdout.write(assert.stdout);
if (assert.stderr) process.stderr.write(assert.stderr);
if (assert.status !== 0) process.exit(assert.status ?? 1);
