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
import { join } from "node:path";
import { pickFreePort } from "./_free-port.js";
import { assertScratchHeld, cotalRootCaptor, killManagerAtRoot, makeScratch } from "../../../bin/smoke/_scratch.js";

// Same temp-root sandbox as the user-mode sibling, and for the same reason: `findCotalRoot` walks to
// `/` unbounded, so a `.cotal` above `tmpdir()` sends this fixture's `manager.pid` into that
// ancestor and step 3's kill silently does nothing. This suite is gated — a red here is read as the
// shipped operator path being broken — so it must never be able to red for a fixture reason.
const scratch = makeScratch("cotal-psstatic-");
const home = mkdtempSync(join(scratch, "home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(scratch, "root-"));
const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `psstatic-${Math.floor(Math.random() * 1e6)}`;
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => { v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? "")); };

/**
 * How the child ENDED rides in the result. `status: null` covers ANY signal death — this suite's
 * timeout, an external SIGTERM/SIGKILL, an OOM kill — and a launch failure never fires `exit` at
 * all. Each of those produces the shape step 3's `claimsEmptySuccess` treats as a pass, so a run
 * that proved nothing prints green. A `timedOut` flag alone only knows about OUR timer.
 */
type Run = {
  status: number | null;
  out: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  launchError?: string;
};
function cotal(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn("npx", ["tsx", BIN, ...args], { cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    let settled = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    // One settle path, so a launch error is not left to the timer and then mislabelled a timeout.
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(t); res(r); };
    child.on("error", (e) => done({ status: null, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (status, signal) => done({ status, out, timedOut, signal }));
  });
}

/** Refuse to grade anything but a self-terminated child with a real exit code: every shape rejected
 *  here would otherwise SATISFY the cells below. */
function mustHaveRun(r: Run, what: string): void {
  const why =
    r.launchError ? `never launched (${r.launchError})`
    : r.timedOut ? "was SIGKILLed by this suite's timeout"
    : r.signal ? `was killed by ${r.signal} from outside this suite`
    : r.status === null ? "ended with neither an exit code nor a signal"
    : null;
  if (why === null) return;
  console.log(`\n  => FIXTURE FAILURE, not a product defect: ${what} ${why}, which fakes the pass shape.\n`);
  process.exit(1);
}

try {
  console.log("1) up (STATIC auth — no --user-auth, no IdP, no device login)");
  // Checked before `up`, because a captured root does not make `up` fail — it makes every later cell
  // grade a mesh that is not this fixture's.
  const captor = cotalRootCaptor(root);
  check("fixture root has no .cotal ancestor (else nothing below can arm)", captor === null, captor);
  if (captor) { console.log("\n  => FIXTURE FAILURE, not a product defect: the temp root is captured.\n"); process.exit(1); }
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
  assertScratchHeld(root, "fixture root");
  // Fatal, not conditional: a skipped kill leaves the manager ALIVE, and a live manager's honest
  // "(no managed agents)" trips `claimsEmptySuccess` below — a fixture failure wearing the costume
  // of the product defect this suite exists to catch.
  console.log(`   killed manager pid ${await killManagerAtRoot(root)} — the cell below grades a DEAD mesh`);
  const psDead = await cotal(["ps", "--space", SPACE], 20_000);
  // Fatal before grading: any of the null-status routes would satisfy `claimsEmptySuccess === false`
  // on evidence this suite fabricated rather than observed.
  mustHaveRun(psDead, "the dead-manager `cotal ps`");
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
  rmSync(scratch, { recursive: true, force: true }); // home and root both live under it
}
if (fail) process.exitCode = 1;
