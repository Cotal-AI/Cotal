import type { NatsConnection } from "@nats-io/transport-node";

/** Drain for at most `graceMs` (one second by default), then close the connection.
 * Broker closure also ends the wait: nats-core can leave drain's final flush pending
 * after `closed()` resolves. A drain rejection does not prove closure either.
 * This is teardown, not proof that pending messages were delivered. Close errors propagate.
 */
export async function drainAndClose(nc: NatsConnection, graceMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!nc.isClosed()) {
      await Promise.race([
        nc.drain().catch(() => {}),
        nc.closed(),
        // Keep this timer referenced so a dead socket cannot strand top-level await.
        new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
      ]);
    }
  } finally {
    clearTimeout(timer);
    await nc.close();
  }
}
