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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pickFreePort } from "./_free-port.js";
import { assertScratchHeld, foreignRootFor, killManagerAtRoot, makeScratch } from "../../../bin/smoke/_scratch.js";

// Same temp-root sandbox as the user-mode sibling, and for the same reason: `findCotalRoot` walks to
// `/` unbounded, so a `.cotal` above `tmpdir()` sends this fixture's `manager.pid` into that
// ancestor and step 3's kill silently does nothing. This suite is gated — a red here is read as the
// shipped operator path being broken — so it must never be able to red for a fixture reason.
const scratch = makeScratch("cotal-psstatic-");
// SETUP TRANSACTION: every line from here to the main body can throw, and a throw used to exit
// with the scratch — including its anchored `.cotal` — still on disk.
const cleanScratch = (e: unknown): never => {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed): ${(e as Error).message}`, { cause: e });
};
let home!: string, root!: string, SERVER!: string;
try {
  home = mkdtempSync(join(scratch, "home-"));
  process.env.COTAL_HOME = home;
  root = mkdtempSync(join(scratch, "root-"));
  // ANCHOR THE ROOT BEFORE ANY PRODUCT COMMAND RUNS: `findCotalRoot` stops at the first `.cotal`
  // from the directory itself, so owning one here pins every later resolution to this root.
  mkdirSync(join(root, ".cotal"), { recursive: true });
  SERVER = `nats://127.0.0.1:${await pickFreePort()}`;
} catch (e) { cleanScratch(e); }
const SPACE = `psstatic-${Math.floor(Math.random() * 1e6)}`;
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");

// Was `cotal up` ever INVOKED? Not "did it succeed" — a failed, timed-out or signalled `up` can still
// have launched detached processes, and those are exactly the ones whose pidfiles must survive.
// Attribution evidence is earned by the attempt, not by the outcome.
let upAttempted = false;

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => { v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? "")); };

/**
 * How the child ENDED rides in the result. `status: null` covers ANY signal death — this suite's
 * timeout, an external SIGTERM/SIGKILL, an OOM kill — and a launch failure never fires `exit` at
 * all. Each of those produces the shape step 3's `claimsEmptySuccess` treats as a pass, so a run
 * that proved nothing prints green. A `timedOut` flag alone only knows about OUR timer.
 */
// How long to keep draining inherited stdio after the direct child exits. Long enough for the tail
// a detached component flushes (measured ~450ms), short enough that a long-lived one cannot hang
// the suite. Exceeding it is reported, never absorbed.
const DRAIN_MS = 2_000;

type Run = {
  status: number | null;
  out: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  launchError?: string;
  /** Descendants held the inherited pipes past the drain bound: `out` is a PREFIX, not the whole. */
  stdioTimedOut?: boolean;
};
function cotal(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn("npx", ["tsx", BIN, ...args], { cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    let settled = false;
    let exited = false;
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let drain: NodeJS.Timeout | undefined;
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(cmd); clearTimeout(drain); res(r); };
    // Descendants still hold our pipe ends. Stop waiting, drop them, and SAY the output is partial
    // rather than grading a prefix silently.
    const giveUpOnStdio = () => { child.stdout?.destroy(); child.stderr?.destroy(); done({ status, out, timedOut, signal, stdioTimedOut: true }); };
    const cmd = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // A kill cannot close pipes an already-exited child handed to a detached descendant, so the
      // command timeout has to be able to settle by itself or the wrapper hangs forever.
      if (exited) giveUpOnStdio(); else drain = setTimeout(giveUpOnStdio, DRAIN_MS);
    }, timeoutMs);
    child.on("error", (e) => done({ status: null, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    // TWO PHASE. `exit` gives the direct child's outcome; `close` gives the complete output, because
    // pipes handed to DETACHED descendants keep carrying text after the child dies (measured:
    // `out: ""` at exit 26ms, `out: "STREAM.INFO"` at close 453ms). But waiting only for `close`
    // hangs whenever a long-lived detached component holds the pipe — which `cotal` creates on
    // purpose. So: record the outcome at `exit`, keep draining, and bound that drain.
    child.on("exit", (s, sg) => { exited = true; status = s; signal = sg; drain = setTimeout(giveUpOnStdio, DRAIN_MS); });
    child.on("close", (s, sg) => done({ status: s ?? status, out, timedOut, signal: sg ?? signal }));
  });
}

/** Refuse to grade anything but a self-terminated child with a real exit code: every shape rejected
 *  here would otherwise SATISFY the cells below. */
function mustHaveRun(r: Run, what: string): void {
  const why =
    r.launchError ? `never launched (${r.launchError})`
    : r.timedOut ? "was SIGKILLed by this suite's timeout"
    : r.signal ? `was killed by ${r.signal} from outside this suite`
    : r.stdioTimedOut ? "left its output incomplete (detached descendants held the pipes past the drain bound)"
    : r.status === null ? "ended with neither an exit code nor a signal"
    : null;
  if (why === null) return;
  // THROW, never `process.exit`. `finally` does not run after `process.exit`, and this suite's
  // `finally` is what stops the detached mesh and removes the temp root. A fail-loud path that
  // leaks a live broker and a poisoned scratch is not fail-loud, it is fail-loud-and-dirty — and
  // the leaked `.cotal` is the exact hazard the rest of this file exists to prevent.
  process.exitCode = 1;
  throw new Error(`FIXTURE FAILURE, not a product defect: ${what} ${why}, which fakes the pass shape.`);
}

try {
  console.log("1) up (STATIC auth — no --user-auth, no IdP, no device login)");
  // DIRECT EXISTENCE, not a consequence of it. `foreignRootFor(root) === null` is ALSO true with no
  // anchor at all under the clean ancestry makeScratch builds, so it cannot tell "anchored" from
  // "nothing here" on an ordinary run - it would have let CI delete the load-bearing anchor and stay
  // green. Assert the thing itself; keep the resolution cell beside it as the consequence.
  // Read ONCE, so the graded cell and the fatal branch cannot report different things about the
  // same instant.
  const anchored = existsSync(join(root, ".cotal"));
  check("the fixture root OWNS its .cotal (the anchor exists)", anchored, root);
  // FATAL HERE, before any product command. A failed `check` alone only increments the tally and
  // lets `up` run UNANCHORED — the precise state whose race this anchor exists to remove. The suite
  // would still exit red, but only after starting a mesh that could root anywhere.
  if (!anchored) {
    process.exitCode = 1;
    throw new Error(`FIXTURE FAILURE: the anchor ${join(root, ".cotal")} is missing, so no product command below can be trusted to root here.`);
  }
  const captor = foreignRootFor(root);
  check("...and therefore outranks any ancestor", captor === null, captor);
  if (captor) { process.exitCode = 1; throw new Error(`FIXTURE FAILURE, not a product defect: anchor missing, ${root} resolves to ${captor}.`); }
  upAttempted = true;
  const up = await cotal(["up", "--detach", "--server", SERVER, "--space", SPACE]);
  // Attribute HOW `up` ended before reading its status: a signalled or timed-out `up` reports
  // `status: null`, which reads only as "non-zero" and loses why.
  mustHaveRun(up, "`cotal up`");
  check("`cotal up` exits 0 — checked FIRST so a fixture failure is distinguishable from a product one", up.status === 0, up.out.slice(-700));
  // Also a throw, not an exit: a PARTIALLY started mesh is the case most in need of the teardown
  // that `finally` performs, and `process.exit` here would strand exactly that.
  if (up.status !== 0) { process.exitCode = 1; throw new Error("FIXTURE FAILURE, not a product defect: no mesh came up, so `ps` was never exercised."); }

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
  // Steps run INDEPENDENTLY: a throw anywhere in a finalizer aborts the rest, stranding a live
  // broker and a scratch while the suite still prints its verdict — teardown failing OPEN.
  // A failing step is RED, not a log line: cleanup that declines and still exits 0 is the same
  // false-green class as the rest of this branch, moved to the end of the run.
  const step = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      process.exitCode = 1;
      console.error(`  ! teardown step "${label}" FAILED: ${(e as Error).message}`);
    }
  };
  // Same guard as the user-mode sibling: `cotal down` re-resolves from cwd, so under a FOREIGN root
  // it signals that root's processes — pids this fixture never started. A teardown that reaches
  // outside its own fixture is worse than no teardown.
  let meshStopped = false;
  await step("stop the mesh", async () => {
    // AN ANCHOR, NOT A GATE — see the user-mode sibling for the full reasoning. `cotal down` is a
    // child that re-resolves its root from cwd, so a pre-spawn check cannot bind its answer; that
    // race was measured killing a foreign process. Only `root/.cotal` existing makes the child's
    // resolution knowable in advance, because nearest-wins means nothing appearing above can outrank
    // it afterwards.
    if (!existsSync(join(root, ".cotal"))) {
      const foreign = foreignRootFor(root);
      throw new Error(
        `refusing \`cotal down\`: ${root} does not own a .cotal, so the child would resolve to whatever root `
          + `wins from its cwd and could signal processes this suite never started`
          + (upAttempted
            ? `. A mesh may have started under ${foreign ? join(foreign, ".cotal") : "another root"} — stop it by hand.`
            : `. Nothing was started.`),
      );
    }
    const down = await cotal(["down"], 60_000);
    // `cotal()` resolves for a timeout, a signal death and a launch failure alike, so an unchecked
    // `await` would read every one of those as a successful stop.
    mustHaveRun(down, "`cotal down`");
    if (down.status !== 0) throw new Error(`\`cotal down\` exited ${down.status}: ${down.out.slice(-300)}`);
    meshStopped = true;
  });
  await step("remove the scratch", () => {
    // The scratch's `.cotal` holds the pidfiles that are the only way to find a mesh this suite
    // failed to stop. Deleting them turns a recoverable orphan into an anonymous one.
    if (upAttempted && !meshStopped) {
      process.exitCode = 1;
      console.error(
        `  ! PRESERVING ${scratch}: the mesh was not confirmed stopped, and its .cotal holds the pidfiles `
          + `needed to find and stop whatever is still running.`,
      );
      return;
    }
    rmSync(scratch, { recursive: true, force: true }); // home and root live under it
  });
}
if (fail) process.exitCode = 1;
