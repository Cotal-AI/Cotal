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
import { isNpx, cotalOnPath, selfArgv, verifiedCotalExecutables } from "../src/lib/self-exec.js";
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
// The version probes spawn candidate executables. Never hand those children credentials inherited
// from a managed agent session.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];

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
const versionedBody = process.platform === "win32"
  ? "@echo off\r\necho cotal-ai 9.8.7\r\n"
  : "#!/bin/sh\nprintf '%s\\n' 'cotal-ai 9.8.7'\n";
const npxCotal = join(npxBin, cotalExe());
const realCotal = join(realBin, cotalExe());
writeFileSync(npxCotal, versionedBody);
writeFileSync(realCotal, versionedBody);
chmodSync(npxCotal, 0o755);
chmodSync(realCotal, 0o755);

process.env.PATH = npxBin; // only the ephemeral npx shim is reachable
check("npx `_npx/.../.bin/cotal` shim on PATH ⇒ cotalOnPath() ignores it (false)", cotalOnPath() === false);

process.env.PATH = [npxBin, realBin].join(delimiter); // ephemeral shim + a durable install
check("a durable `cotal` alongside the npx shim ⇒ cotalOnPath() true", cotalOnPath() === true);

const recoveryHome = mkdtempSync(join(tmpdir(), "cotal-install-recovery-home-"));
const ephemeralRecovery = verifiedCotalExecutables({ ...cleanEnv, HOME: recoveryHome, PATH: npxBin });
const durableRecovery = verifiedCotalExecutables({ ...cleanEnv, HOME: recoveryHome, PATH: realBin });
check(
  "recovery probe: ignores an ephemeral npx executable but verifies the same executable at a durable path",
  ephemeralRecovery.length === 0
    && durableRecovery.length === 1
    && durableRecovery[0]?.path === realCotal
    && durableRecovery[0]?.version === "9.8.7",
);

process.env.PATH = prefix; // restore the deterministic no-cotal PATH

// 4) A reduced non-interactive PATH can omit the installer's default ~/.local/bin while a stale
// system cotal remains reachable. The recovery probe must still find the installer candidate, and
// must accept only a clean first-line version proof.
if (process.platform !== "win32") {
  const home = mkdtempSync(join(tmpdir(), "cotal-install-home-"));
  const userBin = seedCotal(join(home, ".local", "bin"));
  const userCotal = join(userBin, cotalExe());
  writeFileSync(userCotal, "#!/bin/sh\nprintf '%s\\n' 'cotal-ai 9.8.7'\n");
  chmodSync(userCotal, 0o755);
  const found = verifiedCotalExecutables({ ...cleanEnv, HOME: home, PATH: prefix });
  check("recovery probe: reduced PATH still finds ~/.local/bin/cotal", found.some((c) => c.path === userCotal && c.version === "9.8.7"));

  writeFileSync(userCotal, "#!/bin/sh\nprintf '%s\\n' 'wrapper noise' 'cotal-ai 9.8.7'\n");
  chmodSync(userCotal, 0o755);
  check("recovery probe: version proof must be the first output line", verifiedCotalExecutables({ ...cleanEnv, HOME: home, PATH: prefix }).length === 0);
}

// 5) #1629: `selfArgv` builds the argv every detached re-exec is spawned with, and it must refuse
//    an entry that is not the CLI's own. A suite under tsx has `process.argv[1]` pointing at itself,
//    so the "manager" it re-execs is the suite: on a persistent host that measured 970 generations
//    in 4.7 hours, each with its own nats-server and holder. The refusal has to be here rather than
//    in a teardown owner, because the child is unref'd on purpose and nothing can adopt it.
{
  const argv = (p: string): string[] | Error => {
    setArgv(p);
    try { return selfArgv(); } catch (e) { return e as Error; }
  };
  const checkout = argv("/srv/checkout/bin/cotal.ts");
  check("the dev-checkout entry `bin/cotal.ts` builds a re-exec argv ending in that entry",
    Array.isArray(checkout) && checkout[0] === process.execPath && checkout.at(-1) === "/srv/checkout/bin/cotal.ts");
  const installed = argv("/usr/local/lib/node_modules/cotal-ai/dist/cotal.js");
  check("the published entry `dist/cotal.js` builds one too",
    Array.isArray(installed) && installed.at(-1) === "/usr/local/lib/node_modules/cotal-ai/dist/cotal.js");
  // The shape `npm i -g cotal-ai` actually runs under: `<prefix>/bin/cotal` is a symlink into the
  // package and Node leaves argv[1] on the LINK, which has no extension. An extension-only rule
  // would refuse every global install's manager start, so the bare name is pinned here.
  const globalLink = argv("/usr/local/bin/cotal");
  check("a bare `cotal` bin symlink (the global-install shape) builds a re-exec argv",
    Array.isArray(globalLink) && globalLink.at(-1) === "/usr/local/bin/cotal");
  const suite = argv("/srv/checkout/implementations/cli/smoke/delivery-boot-honesty.smoke.ts");
  check("a `.smoke.ts` entry is REFUSED, not re-execed as a daemon", suite instanceof Error);
  check("the refusal names the entry it will not re-exec",
    suite instanceof Error && suite.message.includes("delivery-boot-honesty.smoke.ts"));
  check("and says what a child spawned from it would actually run",
    suite instanceof Error && /re-runs it with a cotal subcommand appended/.test(suite.message));
  check("and names the fixture remedy rather than only the failure",
    suite instanceof Error && /points `process\.argv\[1\]` at the cotal entry/.test(suite.message));
  // The stem is the whole check, so a file that merely SITS beside the entry is refused too: a
  // `bin/run.ts` re-exec would boot the composition root without the Node-version preflight.
  check("a sibling of the entry is not the entry", argv("/srv/checkout/bin/run.ts") instanceof Error);
  check("a process with no entry file at all is refused rather than spawning `[node, undefined]`",
    (() => { const saved = process.argv[1]; delete (process.argv as (string | undefined)[])[1];
      try { selfArgv(); return false; } catch { return true; } finally { process.argv[1] = saved; } })());
}

process.argv[1] = realArgv1;
console.log(failures ? `\ninstall smoke: ${failures} check(s) failed` : "\ninstall smoke: all checks passed");
process.exit(failures ? 1 : 0);
