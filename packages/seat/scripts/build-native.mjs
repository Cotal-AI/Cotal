#!/usr/bin/env node
/**
 * Developer / prepublish compile of the Linux SO_PEERCRED helper.
 *
 * Customer `npm i` does not run this. Published tarballs ship `build/Release/peercred.node`
 * and have no `install` script, so a host without a compiler still installs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const outDir = join(root, "build", "Release");
mkdirSync(outDir, { recursive: true });

if (process.platform !== "linux") {
  process.exit(0);
}

const src = join(root, "native", "peercred.c");
const out = join(outDir, "peercred.node");
const args = ["-shared", "-fPIC", "-D_GNU_SOURCE", "-o", out, src, "-I/usr/include/node"];
const cc = spawnSync("cc", args, { cwd: root, encoding: "utf8" });
if (cc.status !== 0 || cc.error) {
  const detail = cc.error
    ? cc.error.message
    : `${cc.stderr || cc.stdout || `cc exited ${cc.status ?? 1}`}`;
  console.error(
    `@cotal-ai/seat: failed to compile the SO_PEERCRED helper for ${process.platform}-${process.arch}.`,
  );
  console.error(`command: cc ${args.join(" ")}`);
  console.error(detail.trim() || "(no compiler diagnostic)");
  console.error(
    "A C compiler is required to BUILD this package from source. Published tarballs ship the prebuilt helper and do not compile on install.",
  );
  process.exit(cc.status ?? 1);
}
