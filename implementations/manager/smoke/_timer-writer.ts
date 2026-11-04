/**
 * Shared smoke helper: host the timer writer as the delivery daemon does on a live mesh. The pump's
 * `done` rejects on a fault outside one message's handling, such as a fetch that missed its idle
 * heartbeats while the host was loaded. The daemon logs that and restarts the pump; a suite that
 * only called `startTimerWriter` left the rejection unhandled, and Node exited mid-suite. This logs
 * the fault and restarts the pump on the same connection.
 */
import { startTimerWriter } from "@cotal-ai/core";

export interface HostedTimerWriter {
  /** Stop the pump, including a restart in flight. */
  stop: () => Promise<void>;
}

export async function hostTimerWriter(
  nc: Parameters<typeof startTimerWriter>[0],
  space: string,
  opts: { pollMs?: number } = {},
): Promise<HostedTimerWriter> {
  let stopped = false;
  let handle = await startTimerWriter(nc, space, opts);
  const supervising = (async () => {
    for (;;) {
      try {
        await handle.done; // resolves only through stop(); a fault rejects
        return;
      } catch (e) {
        if (stopped) return;
        console.error(`! timer writer: down (${(e as Error).message}) - restarting`);
      }
      for (;;) {
        if (stopped || nc.isClosed()) return;
        try {
          handle = await startTimerWriter(nc, space, opts);
          break;
        } catch (e) {
          console.error(`! timer writer: restart failed (${(e as Error).message}) - retrying in 1s`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      if (stopped) { await handle.stop(); return; }
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await handle.stop();
      await supervising;
    },
  };
}
