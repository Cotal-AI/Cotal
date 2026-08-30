import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "../src/index.js";

let checks = 0;
const check = (name: string, run: () => void): void => {
  assert.doesNotThrow(run, name);
  checks++;
  console.log(`  ✓ ${name}`);
};

const base = mkdtempSync(join(tmpdir(), "cotal-smoke-kit-package-"));
try {
  const root = join(base, "root");
  const cotalHome = join(base, "home");
  const xdgConfigHome = join(base, "config");
  const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome });
  const env = { COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdgConfigHome };
  check("recorded sandbox permits its own down command", () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env }));
  assert.throws(() => assertSmokeSandboxDown(undefined, ["down"], { cwd: root, env }), /missing anchor/);
  checks++;
  console.log("  ✓ missing sandbox anchor is refused");
  check("non-destructive commands do not require the down guard", () => assertSmokeSandboxDown(anchor, ["status"], { cwd: root, env }));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`SMOKE-KIT PACKAGE TESTS: ${checks} tests executed`);
