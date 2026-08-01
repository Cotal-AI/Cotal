/**
 * Bundle import (no test runner) — the SHIPPED dist/launch.js must be importable by plain
 * node. The launcher bundle inlines CJS deps (tweetnacl via @nats-io/nkeys) that
 * `require()` node builtins at import time; esbuild's ESM output only supports that
 * through the createRequire banner in the package's `bundle` script. An installed ext runs
 * exactly this file with node (FROM_BUILD), while dev runs src via tsx — so only this
 * smoke, not any dev flow, catches a banner regression.
 *
 * Rebuilds the bundle with the real `bundle` script (single source of truth), then imports
 * it with an identity-free env: expected outcome is a clean exit 0 with the launcher's
 * "not a managed session" notice, not an import-time crash.
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.platform === "win32") {
  console.log("✓ bundle-import smoke skipped on Windows (the Hermes connector is Unix-only; execFileSync(\"pnpm\") cannot spawn a .cmd)");
  process.exit(0);
}

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

execFileSync("pnpm", ["run", "bundle"], { cwd: pkgDir, stdio: "pipe" });

const res = spawnSync(process.execPath, [join(pkgDir, "dist", "launch.js")], {
  // Identity-free, minimal env: hasIdentity() is false, so a healthy bundle imports, logs
  // the not-a-managed-session notice, and exits 0 before touching uv or any socket.
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  encoding: "utf8",
  timeout: 30_000,
});

assert.equal(
  res.status,
  0,
  `dist/launch.js did not import cleanly (exit ${res.status}):\n${res.stderr}`,
);
assert.match(res.stderr, /not a managed session/, "expected the launcher's identity-free notice");

console.log("bundle-import smoke: dist/launch.js imports cleanly under plain node");
