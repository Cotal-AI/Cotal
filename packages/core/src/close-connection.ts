import type { NatsConnection } from "@nats-io/transport-node";

/** Drain for at most `graceMs` (2 seconds by default), then close the connection. A broker close
 *  ends the wait even when the client's drain promise never settles. Drain failure or expiry does
 *  not confirm delivery of buffered messages. `graceMs` must be an integer from 0 through
 *  2147483647, the largest supported timer delay. Close failures propagate to the caller. */
export async function closeConnection(nc: NatsConnection, graceMs = 2_000): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 2_147_483_647)
    throw new Error("connection drain grace must be a nonnegative safe integer no greater than 2147483647");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!nc.isClosed()) {
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); });
      // Keep the timer referenced: after a transport closes it may be the only live handle left.
      await Promise.race([nc.isDraining() ? nc.closed() : nc.drain(), nc.closed(), deadline]).catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    await nc.close();
  }
}
