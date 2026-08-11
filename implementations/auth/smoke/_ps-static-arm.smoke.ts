/**
 * THE STATIC CONTROL ARM the supervisor pre-registered for the `ps` regression.
 *
 *   BEFORE the fix   static PASS   user-mode FAIL     <- isolates the CREDENTIAL PATH
 *   AFTER  the fix   static PASS   user-mode FAIL on a DIFFERENT denied subject
 *
 * The rule that makes this a control rather than a second claim: **if the static arm FAILS, this run
 * is VOID, not a wider defect.** A static failure means the fixture never armed — `cotal up`, the
 * spawn, or the broker did not come up — and it says nothing about the credential path. Grade it void
 * and report that, rather than reading two reds as "everything is broken".
 *
 * Same shape as the user-mode arm minus the user-mode: `cotal up` with no `--user-auth`, no IdP, no
 * device login, so the CLI presents a locally-minted operator credential instead of a user bearer.
 * Then the same `cotal ps --space` whose output the down-manifest suite discards.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickFreePort } from "./_free-port.js";

const home = mkdtempSync(join(tmpdir(), "cotal-psstatic-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-psstatic-root-"));
const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `psstatic-${Math.floor(Math.random() * 1e6)}`;
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => { v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? "")); };

function cotal(args: string[], timeoutMs = 120_000): Promise<{ status: number | null; out: string }> {
  return new Promise((res) => {
    const child = spawn("npx", ["tsx", BIN, ...args], { cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (status) => { clearTimeout(t); res({ status, out }); });
  });
}

try {
  console.log("1) up (STATIC auth — no --user-auth, no IdP, no device login)");
  const up = await cotal(["up", "--detach", "--server", SERVER, "--space", SPACE]);
  check("CONTROL: `cotal up` exits 0 (else the fixture never armed and this run is VOID)", up.status === 0, up.out.slice(-700));
  if (up.status !== 0) { console.log("\n  => VOID: no mesh, so the ps result below would say nothing about credentials.\n"); process.exit(1); }

  console.log("\n2) cotal ps --space, under the STATIC credential");
  const ps = await cotal(["ps", "--space", SPACE], 20_000);
  console.log(`\n   ===== cotal ps --space ${SPACE} (STATIC) =====`);
  console.log(`   exit status: ${ps.status}`);
  console.log(ps.out.split("\n").map((l) => `   | ${l}`).join("\n"));
  console.log(`   ===== end =====\n`);

  check("STATIC ARM: `cotal ps` exits 0 (the pre-registered control — a FAIL here VOIDS the pair)", ps.status === 0, ps.status);
  console.log(ps.status === 0
    ? "   => control holds: static works, so a user-mode failure isolates to the CREDENTIAL PATH."
    : "   => VOID: the control failed. This is a fixture problem, NOT a wider defect. Do not read the pair.");
  console.log(`\nPS STATIC ARM ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} catch (e) {
  console.error("static arm threw:", e);
  process.exitCode = 1;
} finally {
  await cotal(["down"], 60_000).catch(() => ({ status: 1, out: "" }));
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
if (fail) process.exitCode = 1;
