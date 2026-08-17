/**
 * Shared smoke helper: own a spawned `nats-server` so it dies when this process is SIGNALLED, not
 * only when the suite returns and its `finally` runs.
 *
 * SCOPE, AND A CORRECTION TO THE FIRST VERSION OF IT. This helper covers ONE of two defects, and an
 * earlier draft of this paragraph claimed it covered the only one. It said `finally` teardown is
 * already correct on the normal path, which was measured — ten `bind-fence` runs on a long-lived box
 * left zero brokers and zero store dirs — but measured on ONE suite and then stated about all of
 * them. It does not hold generally. `channels-auth.smoke.ts` has no teardown at all: it passes,
 * reports `AUTH GRANT CHECKS PASSED`, and leaks its store dir on every green run. Sixty-two of them
 * had accumulated over four days when that was finally counted.
 *
 * So there are two defects, and this helper is only the answer to the second:
 *
 *   1. NO NORMAL-PATH TEARDOWN. Nothing to unwind, so the suite leaks whether or not it is killed.
 *      Six suites are in this state. Ownership does NOT fix them, and worse, it makes them read as
 *      handled while they keep manufacturing directories on every pass.
 *   2. TEARDOWN THAT NEVER UNWINDS. The `finally` is correct and the process is SIGNALLED, so it
 *      never runs. That is what this file exists for, and it changes nothing else.
 *
 * Adopting this helper in a suite with defect 1 is a rename, not a fix. Check the normal path first.
 *
 * The two registrations below are INDEPENDENTLY SUFFICIENT under `tsx`, which is worth stating
 * because it is not obvious and it was only established by trying to disable each one: removing
 * either alone still tears the broker down, and only removing OWNERSHIP reinstates the leak. That is
 * why the suite's mutation targets `owned.add` rather than a hook.
 *
 * PARENTAGE IS THE DISCRIMINATOR, NOT ARGV. The helper holds the child handle it spawned and never
 * has to recognize the process later. That matters because argv fails in BOTH directions on a real
 * box: it under-matches (of 151 `spawn("nats-server"` sites, 38 pass a store dir and no config at
 * all, and one passes a prebuilt args variable), and it over-matches (a `server-open.conf` rule
 * covers 8 processes, only some of which are ever a real mesh). Worse, an argv marker can outlive the
 * file it names: across a fuller census of 15 live orphans, 4 named a config path that no longer
 * exists, deleted by the very cleanup that failed to kill the process. Anything that validates a
 * candidate by stat-ing its config would refuse to reap exactly those four.
 *
 * Two numbers above were revised once the census went from 4 orphans to 15: the `server-open.conf`
 * count was 7, and "every one of the 4 observed orphans" was true of the 4 then visible but is 4 of
 * 15 now. The conclusion is unchanged and so is the reason for it; only the ratio was overstated,
 * and an overstated ratio in a paragraph arguing against a matching strategy is worth correcting.
 *
 * WHAT THIS CANNOT DO, and it must be read as a limit rather than a solved problem: SIGKILL is
 * uncatchable. `kill -9` on a suite kills the handle along with the process, and the broker is
 * orphaned with nothing holding it. The minted store-dir token below is the only surviving evidence
 * in that case, and it is what a separate reaper matches. Parentage covers the case this helper
 * fixes; the token covers the case it cannot. Neither covers both.
 */
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

/** The one minted token. A broker started through this helper is recognizable after its owner is
 *  SIGKILLed; a broker started around it is not, so a reaper is only ever as complete as migration. */
export const SMOKE_BROKER_TOKEN = "cotal-smoke-broker-";

/**
 * Kill a broker and DO NOT RETURN until it is actually gone, so the caller's `rmSync` cannot race a
 * process still writing into the tree it is walking.
 *
 * This exists because that race is not theoretical. `bind-fence` sent SIGTERM and removed its tree on
 * the next line; in CI the recursive walk hit a directory nats-server had just written back into and
 * the suite died on `ENOTEMPTY: directory not empty, rmdir
 * '/tmp/cotal-smoke-broker-LilWsp/jetstream/$G/streams/KV_cotal_records_bindfence/msgs'` after every
 * one of its cells had passed.
 *
 * SIGTERM is the reason the window is wide: it asks nats-server to shut down GRACEFULLY, and a
 * graceful shutdown FLUSHES JetStream state to disk. So the signal that is polite to the broker is
 * precisely the one that keeps it writing while the removal walks. Modelled on a fixture that flushes
 * for 250ms after SIGTERM, removing straight away failed 4 times out of 4; waiting for the exit first
 * succeeded 4 out of 4.
 *
 * A NOTE ON WHAT DOES NOT WORK, so nobody re-derives it from the docs. Node's own retry options on
 * `rmSync` (`maxRetries`/`retryDelay`) name ENOTEMPTY explicitly and look like the native answer. They
 * are not: measured on the same fixture they failed 4 out of 4 while burning 5.7 seconds, because the
 * retry re-attempts the failed `rmdir` and never re-walks the directory, so files created during the
 * first walk are never removed and the `rmdir` can never succeed. Waiting is the fix; retrying is not.
 *
 * Never throws — it runs on the teardown path, where a throw would replace the real cause of death.
 * If the broker ignores the first signal it is escalated to SIGKILL rather than waited on forever.
 */
export async function killAndAwaitExit(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM", timeoutMs = 10_000): Promise<void> {
  const dead = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (dead()) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const after = (ms: number): Promise<"timeout"> => new Promise((r) => setTimeout(() => r("timeout"), ms).unref());
  try {
    child.kill(signal);
  } catch {
    return; // already gone; `exit` may never fire, and there is nothing left to wait for
  }
  if ((await Promise.race([exited.then(() => "exited" as const), after(timeoutMs)])) === "timeout") {
    // It ignored the polite signal. Escalate rather than hang the suite's teardown forever.
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
    await Promise.race([exited, after(2_000)]);
  }
}

interface Owned {
  readonly child: ChildProcess;
  readonly storeDir?: string;
}

const owned = new Set<Owned>();
let armed = false;

/** Kill everything owned. Never throws: this runs while the process is already on its way out, where
 *  a throw would replace the real cause of death with a teardown error. Failures are reported on
 *  stderr instead of swallowed, so a teardown that could not complete is still visible. */
function reap(): void {
  for (const o of owned) {
    try {
      o.child.kill("SIGKILL");
    } catch (e) {
      console.error(`smoke broker teardown: could not kill pid ${o.child.pid}: ${(e as Error).message}`);
    }
    if (o.storeDir !== undefined) {
      try {
        rmSync(o.storeDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`smoke broker teardown: could not remove ${o.storeDir}: ${(e as Error).message}`);
      }
    }
  }
  owned.clear();
}

function arm(): void {
  if (armed) return;
  armed = true;
  // THESE TWO ARE INDEPENDENTLY SUFFICIENT UNDER `tsx`, established by disabling each in turn and
  // watching the suite stay green both times. With a signal listener registered, tsx delivers the
  // signal and the handler reaps. With none, tsx converts the signal into an ordinary exit and the
  // `exit` handler reaps: measured directly, a fixture registering only `process.on("exit")`, sent
  // SIGTERM at its own pid, printed `EXIT HANDLER RAN code=143`.
  //
  // Both are kept because the sufficiency is runner-specific, not universal: under plain `node` a
  // default-disposition SIGTERM terminates without running an `exit` handler at all, and there the
  // signal handlers are the only thing left. The suite prints that they are UNOBSERVED here rather
  // than letting a green run imply this runner proved them.
  //
  // READ THIS BEFORE DELETING EITHER ONE. These two are JOINTLY graded, never individually, because
  // tsx converts an unhandled signal into an exit; the suite cannot tell the legs apart and a
  // mutation on either is UNGRADABLE by construction. Under a runner that does not convert, each leg
  // is load-bearing alone. So deleting the signal registration is green here and silently broken
  // anywhere else, and nothing will tell you.
  process.on("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    // A NAMED handler removed with `process.off`, never `removeAllListeners`: this helper is meant to
    // go into many suites, and removing every listener for a signal would silently disable cleanup a
    // suite had already registered, then re-raise so the default kills the process before the
    // disabled handler could ever matter.
    const onSignal = (): void => {
      reap();
      // Registering a listener suppresses the default termination, so re-raise it after cleaning up:
      // a killed seat must still LOOK killed (exit status 128+signo), or a supervisor reading the
      // status learns the wrong thing about why it died.
      process.off(sig, onSignal);
      process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
}

/**
 * Take ownership of an already-spawned broker. Returns a `release` for the suite's own `finally`:
 * once the suite has torn the broker down itself, release stops this helper from touching it again.
 */
export function teardownOnSignal(child: ChildProcess, storeDir?: string): () => void {
  arm();
  const entry: Owned = { child, ...(storeDir === undefined ? {} : { storeDir }) };
  owned.add(entry);
  return () => owned.delete(entry);
}
