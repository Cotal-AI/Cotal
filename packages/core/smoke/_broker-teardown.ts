/**
 * Shared smoke helper: own a spawned `nats-server` so it dies when this process is SIGNALLED, not
 * only when the suite returns and its `finally` runs.
 *
 * SCOPE, measured rather than assumed. `finally` teardown is already correct on the normal path: ten
 * `bind-fence` runs on a long-lived box left zero `bindfence-*` brokers and zero store dirs behind.
 * The defect is exactly and only the signal path, because a signalled node process runs neither
 * `finally` nor an `exit` handler. So this adds a handler and changes nothing else.
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
  // WHICH OF THESE TWO ACTUALLY FIRES DEPENDS ON THE RUNNER, and it is not the one you would guess.
  // Every suite here runs under `tsx`, which converts a terminating signal into an ordinary exit
  // (measured: a fixture with NO signal listener, sent SIGTERM directly, still ran its `exit` handler
  // and reported code 143). So on the runner these suites actually use, the `exit` registration below
  // is the load-bearing one and the signal handlers are redundant.
  //
  // They are kept because the redundancy is one-directional: run the same file under plain `node`
  // (a compiled suite, or a future runner that does not intercept), and a default-disposition SIGTERM
  // terminates without ever running an `exit` handler, at which point the signal handlers are the
  // only thing left. The suite says so in its own output rather than implying both are proven: the
  // signal handlers are UNOBSERVED under `tsx`, not verified by it.
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
