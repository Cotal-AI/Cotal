/**
 * LIVE PROBE (F1): an ADOPTING `cotal up` must complete its resume while the re-entry holds the
 * root maintenance lock.
 *
 * This is the corner the P2 lock hand-off opened. Before that change a resume re-entry held NO
 * lock (`startupLock = resumeAttempt ? undefined : acquire(...)`), so the resume helpers could
 * safely take one for themselves. The re-entry now INHERITS the recovery's lock, and the two adopt
 * helpers — `resumeProvenOrdinaryListener` and `resumeProvenRestoreListener` — still called
 * `completeResumeActivation` WITHOUT it. Its journal writers then self-acquired against a lock this
 * same process already owned. The lock is not reentrant and cannot stale-reap its way out, because
 * the recorded owner is alive: it is us. So the acquire took the "held by a live owner" refusal and
 * the adopt threw.
 *
 * That is the availability half of the P2 fix: the render stayed serialized (P2 itself is closed),
 * but a resume that recovers by ADOPTING an already-live listener — instead of spawning a
 * competitor over the same store — stopped completing.
 *
 * Driven through the REAL command, as a subprocess, against a REAL broker:
 *
 *  1. CONTROL - the interrupted resume stops at the requested boundary (exit 89), leaves the
 *     journal `resume-committed`, and leaves its bound listener ALIVE. Without all three the
 *     recovery below would not take the adopt branch at all, and a pass would be vacuous. This is
 *     the fixture proving it reached the precondition, not an assertion about the fix.
 *  2. SUBJECT - the recovering `cotal up` adopts that live listener and exits 0, consuming the
 *     journal. It must NOT fail on a maintenance-lock refusal: that exact refusal is the finding,
 *     so it is asserted against by name rather than left to a bare non-zero exit.
 *
 * Sandboxes COTAL_HOME under a scratch base with proven-clean `.cotal` ancestry; kills only its own
 * children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-adopt-resume-lock:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

const scratch = makeScratch("cotal-up-adopt-lock-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
process.env.COTAL_HOME = home;

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The ambient environment with every `COTAL_` key stripped, then this smoke's own sandbox put back.
 *
 * A suite can be run from a mesh-joined session, and that environment carries a live credential path
 * and a live broker URL. The child here is the real `cotal` CLI, which DOES read connection material,
 * so spreading `process.env` in unfiltered points it at the CALLER's mesh instead of this sandbox —
 * and it would pass while doing it, which is the failure mode worth naming: not a red, a false green.
 * Strip first, then re-add the one variable the children are meant to see.
 * Enforced by bin/smoke/suite-ambient-env.smoke.ts.
 */
const baseEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home };
})();

/** Blocking `cotal <args>`, the way an operator runs it. */
function runSync(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(TSX, [CLI, ...args], {
    cwd: root,
    env: { ...baseEnv, ...extraEnv },
    encoding: "utf8",
    timeout: 240_000,
  });
}

type Journal = {
  state?: string;
  listenerProof?: { processOwner?: { pid?: number } };
  managerCommit?: { state?: string };
};
const journal = (): Journal =>
  existsSync(journalPath) ? (JSON.parse(readFileSync(journalPath, "utf8")) as Journal) : {};

const alive = (pid: number | undefined): boolean => {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch { return false; }
};

try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "up adopt resume lock fixture");

  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "adopt_alpha";

  console.log("1) CONTROL: an interrupted resume leaves a committed journal and a LIVE listener");
  const first = runSync(["up", "--detach", "--open", "--server", server, "--space", space]);
  ok("the ordinary boot exited 0", first.status === 0, `${first.stdout ?? ""}${first.stderr ?? ""}`.slice(-1200));

  // The cut describes the manager over the ep rails, so it must not be taken until the manager has
  // finished registering there. `up --detach` returns ~2s BEFORE that registration lands (measured,
  // 3/3 on an idle box), and a describe issued into the gap can miss the registration and then wait
  // out its whole 10s deadline rather than retry - a refusal reproduced 1-in-4 with no load at all.
  // A registry write is the cheapest question that only answers once the manager is there. A rail
  // that never answers is a broken fixture, not the residual, so this waits rather than reporting
  // the cut's refusal as the finding.
  let railsUp = false;
  for (let i = 0; i < 30 && !railsUp; i++) {
    if (runSync(["channels", "set", "railprobe", "--desc", "rails", "--space", space]).status === 0) railsUp = true;
    else await sleep(5_000);
  }
  ok("the manager answers on the ep rails before the cut", railsUp);

  const cut = runSync(["down", "--preserve-state"]);
  ok("the cut exited 0", cut.status === 0, `${cut.stdout ?? ""}${cut.stderr ?? ""}`.slice(-1200));

  // Stop the resume right after the manager commit. The listener it spawned is detached, so it
  // outlives this interrupted driver - which is precisely what makes the next `up` ADOPT rather
  // than spawn a competitor over the same store.
  const interrupted = runSync(
    ["up", "--detach", "--server", server, "--space", space],
    { COTAL_SMOKE_EXIT_AFTER_RESUME_COMMIT: "1" },
  );
  ok("the resume stopped at the commit boundary (exit 89)", interrupted.status === 89,
    { status: interrupted.status, log: `${interrupted.stdout ?? ""}${interrupted.stderr ?? ""}`.slice(-1500) });

  const committed = journal();
  ok("the journal is `resume-committed`", committed.state === "resume-committed", committed.state);
  ok("…with awaiting-finalize manager evidence", committed.managerCommit?.state === "awaitingFinalize",
    committed.managerCommit);
  const boundPid = committed.listenerProof?.processOwner?.pid;
  ok("…and its bound listener is ALIVE (the adopt precondition)", alive(boundPid), { boundPid });

  console.log("\n2) SUBJECT: the recovering `cotal up` ADOPTS that live listener under the inherited lock");
  const recovered = runSync(["up", "--detach", "--server", server, "--space", space]);
  const log = `${recovered.stdout ?? ""}${recovered.stderr ?? ""}`;
  // Assert the refusal by NAME. A bare non-zero check would also go red for an unrelated reason and
  // would report this finding for something that is not it.
  ok("the adopt did not fail on a maintenance-lock refusal",
    !/held by a live owner|recovery is already in progress|maintenance lock/i.test(log),
    { status: recovered.status, log: log.slice(-2000) });
  ok("the adopting resume exited 0", recovered.status === 0, { status: recovered.status, log: log.slice(-2000) });
  ok("…and the finalized resume consumed its maintenance journal", !existsSync(journalPath), journal());

  runSync(["down"]);
  console.log(`\nUP ADOPT RESUME LOCK SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { runSync(["down"]); } catch { /* best effort */ }
  await sleep(500);
  // Every runtime record this root holds, whatever space each belongs to. The records are
  // space-keyed now (`manager.<hex>.pid`), and a teardown running after a failure cannot assume
  // which spaces got as far as writing one, so it matches the SHAPE rather than a fixed name list.
  // The pre-segmentation root-scoped spelling matches too, so a root an older build left behind is
  // still swept.
  for (const name of readdirSync(join(root, ".cotal")).filter((n) => /^(nats|manager|delivery)\.([^.]+\.)?pid$/.test(n))) {
    const pid = Number.parseInt(readFileSync(join(root, ".cotal", name), "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}
