/**
 * Codex BUILT-BUNDLE smoke — the class of bug src-via-tsx smokes cannot catch. `cotal spawn`
 * runs the shipped `dist/host.js` (an esbuild ESM bundle with core inlined) under plain Node,
 * NOT the TypeScript source. That bundle must:
 *   1. exist (the buildLaunch target — a dropped shim ships a MODULE_NOT_FOUND at launch);
 *   2. load under `node dist/host.js` without an ESM-runtime error — in particular the
 *      "Dynamic require of \"crypto\"" crash that killed every real launch until the
 *      createRequire banner was added (core's nkeys/tweetnacl deps `require()` at runtime, and
 *      plain-Node ESM has no `require` without the banner).
 * We drive it with an identity but a bogus broker + a fake codex bin, so it loads, wires up, and
 * fails on its OWN terms (never the module-load crash). A crash exit + a "Dynamic require" /
 * "MODULE_NOT_FOUND" on stderr is the failure we assert against.
 *
 * Run: pnpm smoke:codex-dist  (requires `pnpm -F @cotal-ai/connector-codex build` first)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  // Managed Codex agents are POSIX-only by design: the isolated CODEX_HOME symlinks the
  // operator's auth.json, which needs Developer Mode on Windows (docs/connect-codex.md). There
  // is no Windows Codex case anywhere in the suite — this is a stated limitation, not coverage.
  console.log("SKIP codex dist smoke — managed Codex agents are POSIX-only (symlinked auth.json)");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST_JS = fileURLToPath(new URL("../dist/host.js", import.meta.url));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

check("built dist/host.js exists (buildLaunch target packaged)", existsSync(HOST_JS), HOST_JS);

// Load the real bundle under plain Node. No COTAL_CODEX_BIN → the codex PATH preflight throws a
// clean, NAMED error (not a module-load crash and not a raw ENOENT). A missing createRequire
// banner would instead crash with "Dynamic require of \"crypto\"" during import — before any of
// our code runs.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
cleanEnv.PATH = "/nonexistent-dir-for-codex-dist-smoke"; // guarantee `codex` is NOT resolvable

const child = spawn(process.execPath, [HOST_JS], {
  env: {
    ...cleanEnv,
    COTAL_SPACE: "distsmoke",
    COTAL_NAME: "distpeer",
    COTAL_SERVERS: "nats://127.0.0.1:1", // unreachable — the mesh connect is background/best-effort
    COTAL_SUBSCRIBE: "team",
    COTAL_CODEX_HOME: "/tmp",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let err = "";
child.stderr!.setEncoding("utf8");
child.stderr!.on("data", (d: string) => (err += d));
const exitCode = await Promise.race([
  new Promise<number | null>((r) => child.on("exit", (code) => r(code))),
  sleep(15_000).then(() => "timeout" as const),
]);

check("bundle LOADS under plain Node (no ESM require crash)", !/Dynamic require|MODULE_NOT_FOUND|ERR_REQUIRE_ESM/.test(err), err.slice(-300));
check("bundle reaches our code and fails on ITS terms (codex not on PATH)", /codex.*on PATH|needs .*codex/i.test(err), err.slice(-300));
check("bundle exits nonzero on the fatal preflight", exitCode !== 0 && exitCode !== "timeout", exitCode);

console.log(`\nCODEX DIST SMOKE PASSED ✅  (${pass} checks)`);
process.exit(0);
