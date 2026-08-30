/**
 * LIVE PROBE (P2): a RESUMED `cotal up` must render `server.conf` under the ROOT MAINTENANCE LOCK,
 * the way the ordinary and manifest paths already do.
 *
 * `up` used to take the lock at its start EXCEPT on a resume re-entry: `startupLock` was left
 * undefined when `__restoreAttempt`/`__ordinaryResumeAttempt` was set, on the reasoning that the
 * OUTER recovery block already held it. But that outer block RELEASED the lock in its `finally`
 * before re-entering `up`, so the resumed boot ran the whole render (`authSetup` -> `serverConfig`
 * -> `server.conf`) with no lock held at all. The MEMORY resolver config is a whole-broker map, so
 * an unlocked render is an unserialized rewrite of every tenant's trust: exactly what the lock
 * exists to prevent.
 *
 * The re-entry now INHERITS the recovery's lock instead of dropping and re-taking it, which is what
 * closes the window: the journal is written `resume-intent` under that same lock, so there is no
 * instant where a resume is in flight and the root is unlocked. This probe guards that.
 *
 * Driven through the REAL command, as a subprocess, against a REAL broker:
 *
 *  1. CONTROL - an ORDINARY `cotal up` takes the root lock across its render: the lock file
 *     (exclusive create, the acquire's own arbiter) appears with a live recorded owner - the exact
 *     state an independent `acquireMaintenanceLock` refuses as held-by-a-live-owner. Observed
 *     READ-ONLY: an acquiring probe here is itself a live independent owner, and the up's single
 *     non-retrying acquire (or any of its later lock cycles) landing inside a probe-held window
 *     kills the boot under observation - measured on CI, and measured again with an
 *     existence-gated probe racing the up's re-acquire into a wrong-string refusal.
 *  2. `cotal down --preserve-state` leaves a `ready` maintenance journal - the state a bare
 *     `cotal up` recovers by re-entering itself as a resume.
 *  3. SUBJECT - during that resumed `cotal up`, once the journal shows the re-entry is underway,
 *     the same `acquireMaintenanceLock` must be REFUSED, and `server.conf` must NOT be rewritten
 *     while this probe holds the lock. Either one succeeding is the finding: the resumed render
 *     would not be serialized. The acquire is judged by re-reading the journal WHILE holding the
 *     lock, so a resume that merely finished mid-check is not mistaken for a gap.
 *
 * Sandboxes COTAL_HOME under a scratch base with proven-clean `.cotal` ancestry; kills only its own
 * children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-resume-render-lock:live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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

const scratch = makeScratch("cotal-up-resume-lock-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
process.env.COTAL_HOME = home;

const { acquireMaintenanceLock, authDir, maintenancePaths, readMaintenanceJournal, releaseMaintenanceLock } =
  await import("@cotal-ai/workspace");

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

let pass = 0;
const kids: ChildProcess[] = [];
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
const sandboxEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home };
})();

const output = new WeakMap<ChildProcess, () => string>();
const logOf = (cp: ChildProcess) => output.get(cp)?.() ?? "";

function run(args: string[]): ChildProcess {
  const cp = spawn(TSX, [CLI, ...args], {
    cwd: root,
    env: sandboxEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(cp);
  let log = "";
  cp.stdout?.on("data", (b: Buffer) => { log += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { log += b.toString(); });
  output.set(cp, () => log);
  return cp;
}

/** One independent attempt at the root lock, from a LIVE owner (this probe process). */
function tryLock(): { held: true; reason: string } | { held: false; reason: string } {
  try {
    const lock = acquireMaintenanceLock(root);
    releaseMaintenanceLock(lock);
    return { held: false, reason: "acquired" };
  } catch (error) {
    return { held: true, reason: (error as Error).message };
  }
}

const confPath = () => join(authDir(root), "server.conf");
const confStamp = () => (existsSync(confPath()) ? `${statSync(confPath()).mtimeMs}:${readFileSync(confPath(), "utf8").length}` : "absent");
const journalState = (): string => {
  try {
    return (readMaintenanceJournal(root) as { state?: string } | undefined)?.state ?? "none";
  } catch (error) {
    return `unreadable:${(error as Error).message}`;
  }
};

try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "up resume render lock fixture");

  console.log("1) CONTROL: an ORDINARY `cotal up` holds the root lock across its render");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "alpha";
  const first = run(["up", "--detach", "--space", space, "--server", server]);
  const firstExit = once(first, "exit");
  // READ-ONLY control - never acquire while the up is running. `tryLock()` ACQUIRES, so a probe
  // is itself a live independent owner: the up's single non-retrying acquire landing inside a
  // probe-held window dies with "held by a live owner" (measured on CI - the up's log tail carried
  // exactly that refusal while the loop reported no lock seen), and gating the probe on the lock
  // file's existence only moves the race - the up cycles the lock more than once during boot, so
  // the probe then races the RE-acquire into "another maintenance operation acquired the recovered
  // lock" (measured locally, 2 of 6 runs). The lock file IS the acquire's arbiter (exclusive
  // create), so observing it observes the lock: present with a live recorded owner is precisely
  // the state an independent acquire refuses as held-by-a-live-owner, proven without ever putting
  // a competing owner in the up's way. A partially-written or just-released file parses red and
  // the loop simply looks again.
  const ordinaryLockPath = maintenancePaths(root).lock;
  let ordinaryOwner: { pid: number; host: string } | undefined;
  for (let i = 0; i < 3000 && ordinaryOwner === undefined; i++) {
    if (first.exitCode !== null) break;
    try {
      ordinaryOwner = (JSON.parse(readFileSync(ordinaryLockPath, "utf8")) as { owner: { pid: number; host: string } }).owner;
    } catch {
      await sleep(20);
    }
  }
  ok("the ordinary up takes the root lock across its render (lock file present, owner recorded)",
    ordinaryOwner !== undefined, logOf(first).slice(-800));
  const ordinaryOwnerAlive = ((): boolean => {
    try { process.kill(ordinaryOwner!.pid, 0); return true; } catch { return false; }
  })();
  ok("…and the recorded owner is a live process - the state an independent acquire is refused as held-by-a-live-owner",
    ordinaryOwnerAlive, ordinaryOwner);

  await Promise.race([firstExit, sleep(300_000)]);
  ok("the ordinary boot exited 0", first.exitCode === 0, logOf(first).slice(-1500));
  ok("…and rendered server.conf", existsSync(confPath()));

  console.log("\n2) `cotal down --preserve-state` leaves a resumable maintenance journal");
  // The cut describes the manager over the ep rails, so it must not be taken until the manager has
  // finished registering there. A registry write is the cheapest question that only answers once it
  // has. A rail that never answers is a broken fixture, not the residual, so this waits rather than
  // reporting the cut's refusal as the finding.
  let railsUp = false;
  for (let i = 0; i < 30 && !railsUp; i++) {
    const probe = run(["channels", "set", "railprobe", "--desc", "rails", "--space", space]);
    await Promise.race([once(probe, "exit"), sleep(30_000)]);
    if (probe.exitCode === 0) railsUp = true;
    else await sleep(5_000);
  }
  ok("the manager answers on the ep rails before the cut", railsUp);
  const cut = run(["down", "--preserve-state"]);
  await Promise.race([once(cut, "exit"), sleep(240_000)]);
  ok("the cut exited 0", cut.exitCode === 0, logOf(cut).slice(-1500));
  ok("the journal is `ready` (the state a bare `cotal up` recovers)", journalState() === "ready", journalState());

  console.log("\n3) SUBJECT: the RESUMED `cotal up` renders with the root lock free");
  const before = confStamp();
  const resumed = run(["up", "--detach", "--space", space, "--server", server]);
  // Only judge the lock once the OUTER recovery block has finished and the re-entry is underway -
  // otherwise a lucky early acquire would just be racing the outer block, not observing the gap.
  let acquiredDuringResume = false;
  let seenState = "none";
  let gapState = "none";
  for (let i = 0; i < 1500; i++) {
    if (resumed.exitCode !== null) break;
    const state = journalState();
    if (state.startsWith("resume-")) {
      seenState = state;
      // Acquire and RE-READ the journal while still HOLDING it. Reading the state and then probing
      // the lock as two separate steps cannot tell a real gap from a resume that simply finished in
      // between: the resume's last act (`retireOrdinaryResume` -> `consumeRetiredMaintenance`) runs
      // under the lock and removes the journal, so that benign ending would otherwise be reported as
      // a `resume-retired` gap. A real gap is the journal STILL naming a resume in flight while this
      // probe owns the root lock.
      let taken: ReturnType<typeof acquireMaintenanceLock> | undefined;
      try { taken = acquireMaintenanceLock(root); } catch { taken = undefined; }
      if (taken) {
        const during = journalState();
        releaseMaintenanceLock(taken);
        if (during.startsWith("resume-")) { gapState = during; acquiredDuringResume = true; break; }
      }
    }
    await sleep(20);
  }
  ok("the re-entry was reached (journal moved to a resume state)",
    seenState.startsWith("resume-"), { seenState, log: logOf(resumed).slice(-1200) });
  ok("the root maintenance lock is HELD across the resumed render",
    !acquiredDuringResume,
    { seenState, gapState, note: "an independent acquire succeeded while the journal still named a resume in flight" });

  // Hold the lock for real and watch whether the resumed boot renders anyway. A resumed `up` that
  // took the lock could not reach its render while this is held.
  const held = acquireMaintenanceLock(root);
  try {
    let rendered = false;
    for (let i = 0; i < 600 && !rendered; i++) {
      if (resumed.exitCode !== null) break;
      if (confStamp() !== before) rendered = true;
      else await sleep(50);
    }
    ok("…and no render happens while an independent holder owns the root lock",
      !rendered, { before, after: confStamp() });
  } finally {
    releaseMaintenanceLock(held);
  }

  console.log(`\nUP RESUME RENDER LOCK SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const cp of kids) if (cp.exitCode === null) cp.kill("SIGKILL");
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
  try { rmSync(maintenancePaths(root).lock, { force: true }); } catch { /* nothing held */ }
  rmSync(scratch, { recursive: true, force: true });
}
