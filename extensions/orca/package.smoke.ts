import { strict as assert } from "node:assert";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isGoneCode, localCliEnv, OrcaCliError, resolveTerminal } from "./src/driver.js";
import { privateLauncher } from "./src/runtime.js";

// The orca launcher contract is POSIX by construction: a bash script written 0o600 inside a
// 0o700 dir. On Windows those modes are a no-op and bash is not the shell; secret-at-rest
// hardening there is asserted by smoke:secret-fs (NTFS ACLs). Scope, loudly and counted, rather
// than fail on a contract the platform cannot express.
if (process.platform === "win32") {
  console.log("  \u2713 win32: orca launcher contract is POSIX-scoped; NTFS hardening is asserted by smoke:secret-fs");
  process.exit(0);
}


let checks = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  checks++;
  console.log(`  ✓ ${name}`);
};

const clean = localCliEnv({ PATH: "/bin", ORCA_PAIRING_CODE: "secret", orca_environment: "remote" });
check("ordinary environment survives local CLI isolation", clean.PATH === "/bin");
check("remote Orca selectors are stripped case-insensitively", clean.ORCA_PAIRING_CODE === undefined && clean.orca_environment === undefined);
check(
  "isGoneCode matches not_found, stale, and closed codes case-insensitively",
  isGoneCode("terminal_not_found") &&
    isGoneCode("TERMINAL_HANDLE_STALE") &&
    isGoneCode("terminal_closed") &&
    !isGoneCode("terminal_not_writable") &&
    !isGoneCode("timeout") &&
    !isGoneCode(),
);

let showCalls = 0;
const unexpectedShow = () => {
  showCalls++;
  return { ok: true, result: { terminal: { handle: "h_old", connected: true } } };
};
check(
  "resolveTerminal matches by ptyId and skips show",
  resolveTerminal({ handle: "h_old", ptyId: "p1" }, [{ handle: "h_new", ptyId: "p1", connected: true }], unexpectedShow)?.handle === "h_new" &&
    showCalls === 0,
);
check(
  "resolveTerminal treats an unlisted ptyId as gone without calling show",
  resolveTerminal({ handle: "h_old", ptyId: "p1" }, [{ handle: "h_old", ptyId: "p2", connected: true }], unexpectedShow) === undefined &&
    showCalls === 0,
);
check(
  "resolveTerminal falls back to show only when ptyId is absent and unlisted",
  resolveTerminal({ handle: "h1" }, [], () => {
    showCalls++;
    return { ok: true, result: { terminal: { handle: "h1", connected: true } } };
  })?.handle === "h1" && showCalls === 1,
);
check(
  "resolveTerminal treats gone show codes as undefined",
  resolveTerminal({ handle: "h1" }, [], () => ({ ok: false, error: { code: "terminal_stale" } })) === undefined,
);
let nonGoneShowErr: unknown;
try {
  resolveTerminal({ handle: "h1" }, [], () => ({ ok: false, error: { code: "permission_denied", message: "denied" } }));
} catch (err) {
  nonGoneShowErr = err;
}
check(
  "resolveTerminal surfaces non-gone show errors as OrcaCliError",
  nonGoneShowErr instanceof OrcaCliError && nonGoneShowErr.code === "permission_denied",
);
let emptyShowErr: unknown;
try {
  resolveTerminal({ handle: "h1" }, [], () => ({ ok: true, result: {} }));
} catch (err) {
  emptyShowErr = err;
}
check(
  "resolveTerminal rejects a show envelope with no terminal",
  emptyShowErr instanceof Error && emptyShowErr.message === "orca terminal show returned no authoritative state for h1",
);

const secret = "orca-package-test-secret";
const launcher = privateLauncher({ command: process.execPath, args: ["-e", ""], env: { TOKEN: secret } }, process.cwd());
try {
  check("launcher command does not expose secret env", !launcher.command.includes(secret));
  check("launcher script is owner-only", (statSync(launcher.script).mode & 0o777) === 0o600);
  check("launcher directory is owner-only", (statSync(dirname(launcher.script)).mode & 0o777) === 0o700);
  check("secret is confined to the private launcher", readFileSync(launcher.script, "utf8").includes(secret));
} finally {
  rmSync(launcher.dir, { recursive: true, force: true });
}

console.log(`ORCA PACKAGE TESTS: ${checks} tests executed`);
