/**
 * Global-install offer smoke (no real install, no network) — run with: pnpm smoke:install
 *
 * Drives the real `offerGlobalInstall` from setup.ts in isolation: an unreachable npm registry +
 * a throwaway prefix so any `npm i -g` fails fast and can never touch the real global install. It
 * proves the gate (npx + no global `cotal`) and that a failed install is handled gracefully (the
 * feature is best-effort and must never throw / abort setup).
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isNpx, cotalOnPath } from "../src/lib/self-exec.js";
import { offerGlobalInstall } from "../src/commands/setup.js";

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

// Belt-and-suspenders: even if the gate let an install through, point npm at a dead registry and a
// throwaway prefix so it fails fast and never writes to the real global location.
const prefix = mkdtempSync(join(tmpdir(), "cotal-install-smoke-"));
process.env.npm_config_prefix = prefix;
process.env.npm_config_registry = "http://127.0.0.1:9"; // unreachable → fast fail
process.env.npm_config_fetch_retries = "0";
process.env.npm_config_fetch_timeout = "2000";
// Make the PATH scan deterministic: a temp dir with no `cotal`, so cotalOnPath() is false.
process.env.PATH = prefix;

const realArgv1 = process.argv[1];
const setArgv = (p: string) => (process.argv[1] = p);

// 1) Gate closed: a normal (non-npx) invocation must no-op (return immediately, no install).
setArgv("/Users/x/repo/bin/cotal.ts");
check("not-npx ⇒ isNpx() false (gate closed)", isNpx() === false);
let threw = false;
try {
  await offerGlobalInstall(false);
} catch {
  threw = true;
}
check("not-npx ⇒ offerGlobalInstall returns without throwing", !threw);

// 2) Gate open: an npx invocation with no global `cotal`, non-TTY (takes the default = install).
//    The install must fail fast (dead registry) and be handled gracefully — never throw.
setArgv("/Users/x/.npm/_npx/abc123/node_modules/cotal-ai/dist/cotal.js");
check("npx ⇒ isNpx() true (gate open)", isNpx() === true);
check("cotal not resolvable on (temp) PATH ⇒ gate proceeds", cotalOnPath() === false);
threw = false;
try {
  await offerGlobalInstall(false); // non-TTY here ⇒ takes default ⇒ attempts npm i -g
} catch (e) {
  threw = true;
  console.log(`  unexpected throw: ${(e as Error).message}`);
}
check("npx install path: failed install handled gracefully (no throw)", !threw);
check("nothing actually installed: `cotal` still not on PATH", cotalOnPath() === false);

// 3) Regression: npx prepends its own `<cache>/_npx/<hash>/node_modules/.bin` (holding a throwaway
//    `cotal`, since cotal-ai declares that bin) to PATH. That shim must NOT count as installed —
//    else `npx cotal-ai setup` skips the global-install offer and hands out `cotal …` hints the
//    user can't run once npx exits. This is the exact PATH the earlier `= prefix` reset stripped.
const cotalExe = () => (process.platform === "win32" ? "cotal.cmd" : "cotal");
function seedCotal(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, cotalExe());
  writeFileSync(f, "#!/bin/sh\n");
  chmodSync(f, 0o755);
  return dir;
}
const npxBin = seedCotal(join(prefix, "_npx", "deadbeef", "node_modules", ".bin"));
const realBin = seedCotal(join(prefix, "realbin"));

process.env.PATH = npxBin; // only the ephemeral npx shim is reachable
check("npx `_npx/.../.bin/cotal` shim on PATH ⇒ cotalOnPath() ignores it (false)", cotalOnPath() === false);

process.env.PATH = [npxBin, realBin].join(delimiter); // ephemeral shim + a durable install
check("a durable `cotal` alongside the npx shim ⇒ cotalOnPath() true", cotalOnPath() === true);

process.env.PATH = prefix; // restore the deterministic no-cotal PATH

process.argv[1] = realArgv1;
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
