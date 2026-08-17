/**
 * Broker teardown on signal. Needs `nats-server` on PATH. Run: pnpm smoke:broker-teardown
 *
 * A smoke that spawns `nats-server` tears it down in `finally`, and `finally` does not run when the
 * node process is SIGNALLED, which is what happens when a seat is killed. Observed on a long-lived
 * box: the suite dies, the broker reparents to ppid 1 with its port still bound and its store dir
 * still on disk, and nothing ever reaps it.
 *
 * Every cell here drives a real child process running a real `nats-server`, and reads the broker's
 * liveness from the OS rather than from the helper's own bookkeeping. The first cell is the POSITIVE
 * CONTROL: the same fixture WITHOUT ownership must still leak, or the cells below prove nothing about
 * the helper. The last cell asserts the limit rather than hiding it: SIGKILL is uncatchable, and a
 * partial mitigation that reads as a solved problem is worse than a stated one.
 */
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`✗ FAIL: ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const FIXTURE = join(import.meta.dirname, "_broker-teardown-child.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Liveness straight from the OS. `kill(pid, 0)` throws ESRCH once the process is gone; a broker that
 *  has exited but not been reaped would be a zombie, which `ps` is asked about separately below. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return spawnSync("ps", ["-o", "stat=", "-p", String(pid)]).stdout.toString().trim().startsWith("Z") === false;
}

interface Started {
  /** The `tsx` wrapper. Signalling THIS is not the signal path: it makes the forked child exit with
   *  code 13 and run its exit handler, never receiving the signal at all. */
  readonly proc: ChildProcess;
  /** The process that actually spawned the broker and holds the handle. Signal this one. */
  readonly selfPid: number;
  readonly brokerPid: number;
  readonly storeDir: string;
}

/** Start the fixture and wait for it to report the broker it spawned. */
async function start(mode: "clean" | "signal" | "unowned"): Promise<Started> {
  const proc = spawn("node_modules/.bin/tsx", [FIXTURE, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
  let err = "";
  proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
  for (let i = 0; i < 200; i++) {
    const m = /READY (\d+) (\d+) (\S+)/.exec(out);
    if (m) return { proc, selfPid: Number(m[1]), brokerPid: Number(m[2]), storeDir: m[3] };
    if (proc.exitCode !== null && mode !== "clean") throw new Error(`fixture(${mode}) exited before READY: ${err}`);
    await wait(100);
  }
  throw new Error(`fixture(${mode}) never printed READY: ${err}`);
}

/** Wait for the fixture process itself to exit, and return how it exited. */
function ended(proc: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  return new Promise((r) => proc.on("exit", (code, signal) => r({ code, signal })));
}

/** Belt and braces for a cell that leaks ON PURPOSE: never leave this suite's own orphan behind. */
function reapOwn(brokerPid: number, storeDir: string): void {
  try {
    process.kill(brokerPid, "SIGKILL");
  } catch {
    // already gone, which is what the owned cells assert
  }
  rmSync(storeDir, { recursive: true, force: true });
}

try {
  // 1. POSITIVE CONTROL. The identical fixture without ownership must leak on SIGTERM. This is the
  //    reproduction, run as a cell, and it is what makes cells 2-4 mean something.
  //
  //    IF THIS CELL JUST WENT RED ON YOU, READ THIS BEFORE TREATING IT AS A REGRESSION. It asserts
  //    that the leak HAPPENS. It is not a leak detector and it does not guard anything; it keeps
  //    passing whether or not the teardown works, which is exactly its job. So it goes red in one
  //    interesting case: somebody fixed the leak AT ITS SOURCE, and an unowned broker no longer
  //    outlives its signalled parent. If that is what you just did, this cell is correct to fail.
  //    Confirm it first: run the fixture in `unowned` mode by hand and watch the broker's pid. Then
  //    re-derive whether the helper is still needed, and RETIRE THIS CELL ONLY.
  //
  //    Not the cells below it, which is what an earlier draft of this comment said and had wrong.
  //    They do go vacuous when the leak cannot happen, but vacuous is not the same as retired. A
  //    retired check matches nothing BY CONSTRUCTION and reads healthy while measuring nothing;
  //    these still spawn a real fixture, signal a real pid, and read liveness from the OS, so they
  //    go red the moment a source fix is reverted. Deleting them would let that revert restore the
  //    leak in silence, which is the one failure class a fresh CI box can never witness.
  {
    const s = await start("unowned");
    process.kill(s.selfPid, "SIGTERM");
    await ended(s.proc);
    await wait(500);
    const leaked = alive(s.brokerPid);
    check("CONTROL: an unowned broker SURVIVES its signalled parent", leaked, `pid ${s.brokerPid}`);
    check("CONTROL: and its store dir is left on disk", existsSync(s.storeDir), s.storeDir);
    reapOwn(s.brokerPid, s.storeDir);
  }

  // 2. The fix, on the signal a killed seat actually receives.
  {
    const s = await start("signal");
    process.kill(s.selfPid, "SIGTERM");
    const how = await ended(s.proc);
    await wait(500);
    check("SIGTERM: the owned broker is gone", !alive(s.brokerPid), `pid ${s.brokerPid}`);
    check("SIGTERM: its store dir is removed", !existsSync(s.storeDir), s.storeDir);
    // A killed seat must still LOOK killed, or a supervisor reading the status learns the wrong
    // thing about why it died. Node reports this as signalCode when the default disposition is
    // restored and the signal re-raised.
    check("SIGTERM: the suite still dies BY the signal, not with a clean 0", how.signal === "SIGTERM" || how.code === 143, JSON.stringify(how));
    reapOwn(s.brokerPid, s.storeDir);
  }

  // 3. The other signal a terminal or a supervisor sends.
  {
    const s = await start("signal");
    process.kill(s.selfPid, "SIGINT");
    await ended(s.proc);
    await wait(500);
    check("SIGINT: the owned broker is gone", !alive(s.brokerPid), `pid ${s.brokerPid}`);
    check("SIGINT: its store dir is removed", !existsSync(s.storeDir), s.storeDir);
    reapOwn(s.brokerPid, s.storeDir);
  }

  // 4. The normal path must be UNCHANGED where a suite HAS one, which is the claim this cell makes
  //    and the only one it can make. The fixture tears its own broker down, so what is guarded here
  //    is that the helper does not break a teardown that already works: measured on bind-fence, ten
  //    runs, zero brokers and zero store dirs left.
  //
  //    It says nothing about a suite with NO normal-path teardown, and an earlier version of this
  //    comment implied otherwise by calling the normal path "already correct" without a subject. Six
  //    suites have none; `channels-auth` passes and leaks a store dir every run. For those, adopting
  //    the helper is a rename rather than a fix, and this cell would stay green throughout.
  //
  //    The fixture models a real suite here: it kills the broker itself and releases ownership,
  //    because a live spawned child holds the event loop open and a suite that skipped that would
  //    never exit.
  {
    const s = await start("clean");
    const how = await ended(s.proc);
    await wait(500);
    check("clean exit: the broker is gone", !alive(s.brokerPid), `pid ${s.brokerPid}`);
    check("clean exit: its store dir is removed", !existsSync(s.storeDir), s.storeDir);
    check("clean exit: still exits 0, so a green run stays green", how.code === 0 && how.signal === null, JSON.stringify(how));
    reapOwn(s.brokerPid, s.storeDir);
  }

  // 5. THE LIMIT, asserted rather than omitted. SIGKILL is uncatchable: the handler never runs, the
  //    handle dies with the process, and the broker is orphaned with nothing holding it. The minted
  //    store-dir token is the only surviving evidence, which is what a separate reaper must match.
  {
    const s = await start("signal");
    process.kill(s.selfPid, "SIGKILL");
    await ended(s.proc);
    await wait(500);
    check("LIMIT: SIGKILL still orphans the broker, and this helper cannot fix that", alive(s.brokerPid), `pid ${s.brokerPid}`);
    check("LIMIT: the orphan carries the minted token, the only evidence a reaper can match", s.storeDir.includes("cotal-smoke-broker-"), s.storeDir);
    reapOwn(s.brokerPid, s.storeDir);
  }
  // 6. The OTHER way a suite dies, and the reason the cells above signal the fixture's own pid rather
  //    than its `tsx` wrapper. Killing the wrapper does not signal the fixture at all: it exits with
  //    code 13 (unsettled top-level await) and runs its exit handler. That path is real and is what a
  //    killed terminal produces, so it gets its own cell, but grading it while calling it the signal
  //    path would have graded the exit handler and reported the signal handlers as proven.
  {
    const s = await start("signal");
    s.proc.kill("SIGTERM");
    const how = await ended(s.proc);
    await wait(500);
    check("wrapper killed: the broker is still torn down, by the exit handler", !alive(s.brokerPid), `pid ${s.brokerPid}`);
    check("wrapper killed: the fixture exited rather than being signalled", how.signal === null, JSON.stringify(how));
    reapOwn(s.brokerPid, s.storeDir);
  }
} finally {
  // Nothing to release: every cell reaps its own broker above, including the two that leak on purpose.
}

// Stated because the cells above cannot show it, and silence here would read as coverage. Under
// `tsx`, which is how every one of these suites runs, a terminating signal arrives as an ordinary
// exit: a fixture with NO signal listener, sent SIGTERM directly, still runs its `exit` handler and
// reports code 143. So the cells above are carried by the `exit` registration, and the helper's
// SIGINT/SIGTERM/SIGHUP handlers are UNOBSERVED here, not passed. They exist for a runner that does
// not intercept, where a default-disposition signal would skip `exit` entirely, and that runner is
// not this one.
console.log("\n  · the signal handlers themselves are UNOBSERVED under `tsx`, which delivers a signal");
console.log("    as an ordinary exit. What these cells prove is the teardown, not which hook ran it.");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("SMOKE OK: broker-teardown");
