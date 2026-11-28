import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { isCommandFailure } from "@cotal-ai/workspace";
import { RestoreAdmissionPending } from "@cotal-ai/cli/update";
import { managerViaDaemon, openVerified } from "./client.js";
import { EndpointRefusal, type DaemonPaths } from "./endpoint.js";
import { excludeLifetime } from "./lifetime.js";

function retryable(error: unknown): boolean {
  if (isCommandFailure(error)) return error.native?.code === "SEATS_ACTIVE" ||
    error.native?.code === "MANAGER_UNAVAILABLE" && /hosted Manager (?:did not confirm the generation request|still holds seats or cannot confirm an idle preservation fence)/.test(error.message);
  return false;
}

/** Reserve the normal empty restart fence, or leave the verified rollback for another attempt. */
export async function prepareRestoreFence(paths: DaemonPaths): Promise<boolean> {
  const deadline = performance.now() + 30_000;
  let confirmedBusy = false;
  for (;;) {
    try {
      await managerViaDaemon({ paths, timeoutMs: Math.min(20_000, Math.max(1, Math.floor(deadline - performance.now()))) }, { op: "managers-prepare-restart" });
      return true;
    } catch (error) {
      if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") {
        excludeLifetime(paths.lock).release();
        return false;
      }
      if (retryable(error)) confirmedBusy = true;
      else if (!(confirmedBusy && error instanceof Error && error.message === "timed out waiting for the daemon's reply")) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await delay(Math.min(250, remaining));
      if (performance.now() >= deadline) break;
    }
  }
  const daemon = await openVerified({ paths, timeoutMs: 1_000 });
  daemon.destroy();
  // A timed-out request may still have reached the daemon. Release only this process's fence.
  await managerViaDaemon({ paths, timeoutMs: 1_000 }, { op: "managers-abort-restart" }).catch(() => {});
  throw new RestoreAdmissionPending();
}
