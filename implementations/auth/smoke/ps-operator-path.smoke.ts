/**
 * THE OPERATOR `ps` PATH WORKS: `cotal up` (static auth, no `--user-auth`, no IdP, no device login,
 * so the CLI presents a locally-minted operator credential) then `cotal ps --space`.
 *
 * A RED HERE IS A REAL DEFECT. It began life as the control arm of a BEFORE/AFTER pair, where a
 * static failure meant "the fixture never armed, grade the pair void". **That reading does not
 * transfer and would be actively harmful now** — as a gated suite its job is the opposite: it says
 * the shipped operator path is broken. The `cotal up` cell below distinguishes the two, and it is
 * checked FIRST for exactly that reason: `up` red means the fixture; `up` green with `ps` red means
 * the product.
 *
 * WHY IT IS GATED. It caught a real regression in its first outing, from a change two people had
 * agreed looked safe: converting the freeze enumeration from `kv.keys()` to a `STREAM.INFO`
 * `subjects_filter` without adding the matching `$JS.API.STREAM.INFO.KV_<records>` row to
 * `scatterFreezeReadRows`. The symptom surfaces hundreds of lines from the cause, as a NATS
 * permissions violation on a records-bucket subject, which is why it cost a night to find once.
 *
 * Mutation-proved: delete that grant row and this suite goes red.
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
  check("`cotal up` exits 0 — checked FIRST so a fixture failure is distinguishable from a product one", up.status === 0, up.out.slice(-700));
  if (up.status !== 0) { console.log("\n  => FIXTURE FAILURE, not a product defect: no mesh came up, so `ps` was never exercised.\n"); process.exit(1); }

  console.log("\n2) cotal ps --space, under the STATIC credential");
  const ps = await cotal(["ps", "--space", SPACE], 20_000);
  console.log(`\n   ===== cotal ps --space ${SPACE} (STATIC) =====`);
  console.log(`   exit status: ${ps.status}`);
  console.log(ps.out.split("\n").map((l) => `   | ${l}`).join("\n"));
  console.log(`   ===== end =====\n`);

  check("the OPERATOR `cotal ps` exits 0 (a RED here is a real defect: the shipped operator path is broken)", ps.status === 0, ps.status);
  console.log(ps.status === 0
    ? "   => the operator path works."
    : "   => OPERATOR PATH BROKEN. The mesh came up (checked above), so this is the product, not the fixture.\n" +
      "      Most likely a records-bucket read the operator instrument no longer holds — read the denied\n" +
      "      subject above and compare it against scatterFreezeReadRows in packages/core/src/provision.ts.");

  // Completeness honesty: with the manager dead, ps must not print a bare empty list that reads
  // as "no agents". Scatter labels the instance unreachable; a total failure exits non-zero.
  console.log("\n3) manager stopped — ps must not claim a completeness it lacks");
  const { readFileSync, existsSync } = await import("node:fs");
  const pidFile = join(root, ".cotal", "manager.pid");
  if (existsSync(pidFile)) {
    try { process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const psDead = await cotal(["ps", "--space", SPACE], 20_000);
  console.log(`   dead-manager ps exit=${psDead.status}`);
  console.log(psDead.out.split("\n").map((l) => `   | ${l}`).join("\n").slice(0, 500));
  const claimsEmptySuccess =
    psDead.status === 0 &&
    !/unreachable/i.test(psDead.out) &&
    (/\(no managed agents\)/.test(psDead.out) || psDead.out.trim() === "");
  check(
    "dead manager: ps does not print a bare empty success (unreachable or non-zero, never silent 'no agents')",
    !claimsEmptySuccess,
    { status: psDead.status, out: psDead.out.slice(-300) },
  );

  console.log(`\nPS OPERATOR PATH ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} catch (e) {
  console.error("ps-operator-path threw:", e);
  process.exitCode = 1;
} finally {
  await cotal(["down"], 60_000).catch(() => ({ status: 1, out: "" }));
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
if (fail) process.exitCode = 1;
