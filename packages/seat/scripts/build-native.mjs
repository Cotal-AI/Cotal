#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const outDir = join(root, "build", "Release");
mkdirSync(outDir, { recursive: true });

if (process.platform !== "linux") {
  process.exit(0);
}

const nodeGyp = join(root, "..", "..", "node_modules", ".bin", "node-gyp");
const gyp = existsSync(nodeGyp) ? nodeGyp : "node-gyp";
const run = spawnSync(gyp, ["rebuild", "--directory", root], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (run.status !== 0) {
  // node-gyp may be missing in a fresh workspace. Compile the N-API module directly.
  const src = join(root, "native", "peercred.c");
  const out = join(outDir, "peercred.node");
  const cc = spawnSync(
    "cc",
    ["-shared", "-fPIC", "-o", out, src, "-I/usr/include/node"],
    { cwd: root, stdio: "inherit" },
  );
  if (cc.status !== 0) process.exit(cc.status ?? 1);
}
