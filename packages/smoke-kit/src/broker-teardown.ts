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
 * protects 7 processes of which only 3 are the real mesh). Worse, an argv marker can outlive the file
 * it names: every one of the 4 observed orphans names a config path that no longer exists, deleted by
 * the very cleanup that failed to kill the process. Anything that validates a candidate by stat-ing
 * its config would refuse to reap all four.
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
