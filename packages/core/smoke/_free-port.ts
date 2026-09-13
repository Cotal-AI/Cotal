import { createServer } from "node:net";

/**
 * OS-assigned free loopback port for a smoke broker. Picking from a random range
 * intermittently lands on a port the OS refuses to bind (Windows reserves scattered
 * Hyper-V/WinNAT port blocks) or one already in use; `listen(0)` avoids both.
 */
export const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close();
        reject(new Error("pickFreePort: no address on probe listener"));
        return;
      }
      probe.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });

/** One attempt's outcome, for the error a failed run raises. */
interface PortAttempt {
  port: number;
  reason: string;
}

export interface StartedOnPort<T> {
  started: T;
  port: number;
  attempts: number;
}

/**
 * Start something on a free loopback port, and treat "it never came up" as a
 * reason to try another port rather than as the end of the run.
 *
 * `pickFreePort` closes its probe before the caller binds, so the port belongs
 * to nobody in between. Under a parallel shard that window is wide enough to
 * lose: a fixture broker was promised 45019, something else took it, and the
 * readiness loop then waited the full 10s for a server that was never going to
 * come up (#1583). The window cannot be closed for a SPAWNED process — the
 * handle cannot be handed to `nats-server` — so the answer is to notice and
 * move, which is also what every call site's readiness probe already knows how
 * to do.
 *
 * `stop` runs for every attempt that fails readiness, so a process that DID
 * start but stayed unreachable is not left behind. A failure names every port
 * tried: a rare red that reports one port reads as an unhealthy runner, and
 * that is how this one was misread for as long as it was.
 */
export const startOnFreePort = async <T>(
  start: (port: number) => Promise<T> | T,
  isUp: (port: number) => Promise<boolean>,
  stop: (started: T) => Promise<void> | void,
  attempts = 3,
): Promise<StartedOnPort<T>> => {
  if (attempts < 1) throw new Error(`startOnFreePort: attempts must be at least 1, got ${attempts}`);
  const tried: PortAttempt[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await pickFreePort();
    let started: T;
    try {
      started = await start(port);
    } catch (error) {
      tried.push({ port, reason: `start threw: ${(error as Error).message}` });
      continue;
    }

    if (await isUp(port)) return { started, port, attempts: attempt };

    tried.push({ port, reason: "never became reachable" });
    await stop(started);
  }

  throw new Error(
    `startOnFreePort: nothing came up after ${attempts} attempt(s) — ` +
      tried.map((t) => `${t.port} (${t.reason})`).join(", "),
  );
};
