import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { resolveOnPath } from "../src/bin-path.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-bin-path-"));
try {
  const dir = join(root, "relative-bin");
  mkdirSync(dir);
  const name = process.platform === "win32" ? "relative-harness.cmd" : "relative-harness";
  const binary = join(dir, name);
  writeFileSync(binary, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(binary, 0o700);
  const found = resolveOnPath("relative-harness", {
    PATH: relative(process.cwd(), dir),
    ...(process.platform === "win32" ? { PATHEXT: ".CMD" } : {}),
  });
  check("relative PATH entries resolve to the exact absolute executable", found === binary && isAbsolute(found), { found, binary });

  console.log(`\n${pass} checks passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
