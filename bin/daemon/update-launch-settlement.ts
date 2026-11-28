import { setTimeout as delay } from "node:timers/promises";
import { withIdpSessionDir } from "@cotal-ai/auth";
import { homeCotalDir, resolveControlTarget, shellPath } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { inspectHostedLaunches } from "./client.js";
import type { DaemonPaths } from "./endpoint.js";
import type { HostedLaunches } from "./protocol.js";

export class HostedLaunchSettlementTimeout extends Error {}

type LaunchStatus = { instanceId?: unknown; agentCount?: number; custody?: string; stopImpact?: { reservedLaunches?: number } };

export function readSettledHostedStatus(paths: DaemonPaths, space: string, instanceId: string, retry: "update" | "update --self", report: (line: string) => void): Promise<LaunchStatus> {
  return withIdpSessionDir(homeCotalDir(), async () => {
    const target = await resolveControlTarget({ space }, "control-caller-privileged", instanceId, { onRefusal: "throw", readOnly: true });
    const client = { versionSkew: (text: string) => text, roster: async () => [] };
    return waitForHostedLaunches(paths, space, instanceId, async timeoutMs => {
      const reply = await askManager(client, space, target.server, "managerStatus", undefined, target.auth, "owner", timeoutMs, { instanceId });
      if (!reply.ok) throw new Error(reply.error ?? "hosted Manager status did not answer");
      return reply.data as LaunchStatus;
    }, retry, report);
  });
}

/** Wait for reservations, never for steady-state seats. A later restart still needs its own fence. */
async function waitForHostedLaunches(
  paths: DaemonPaths, space: string, instanceId: string, read: (timeoutMs: number) => Promise<LaunchStatus>,
  retry: "update" | "update --self", report: (line: string) => void,
): Promise<LaunchStatus> {
  const deadline = performance.now() + 15_000;
  let reported = false;
  let held: HostedLaunches | undefined;
  let privateSupported = true;
  const remaining = () => Math.ceil(deadline - performance.now());
  const retryCommand = `\`cotal ${retry}\``;
  const timedOut = () => {
    const named = held?.held ? `${held.names.map(name => JSON.stringify(name)).join(", ")}${held.held > held.names.length ? ` and ${held.held - held.names.length} more` : ""}` : undefined;
    return new HostedLaunchSettlementTimeout(named
      ? `Hosted PTY launch still held in space ${space}: ${named}. No installed packages were changed. To clear the hold, run \`cotal daemon service-disconnect --space ${shellPath(space)}\`, then retry ${retryCommand}.`
      : `A hosted spawn in space ${space} is still in progress. No installed packages were changed. When it finishes, retry ${retryCommand}.`);
  };
  for (;;) {
    if (remaining() <= 0) throw timedOut();
    const status = await read(Math.min(3_000, remaining()));
    if (status.instanceId !== instanceId) throw new Error(`Manager ${space} identity changed while checking launch settlement`);
    const reserved = status.stopImpact?.reservedLaunches;
    if (reserved === undefined || reserved === 0) return status;
    if (!Number.isSafeInteger(reserved) || reserved < 0) throw new Error(`Manager ${space} returned an invalid launch reservation count`);
    if (privateSupported && remaining() > 500) {
      held = await inspectHostedLaunches(paths, space, instanceId, Math.min(3_000, Math.floor(remaining() / 2)));
      privateSupported = held !== undefined;
      // The private observation is newer than the public status. Re-read the status for the
      // settled seat inventory rather than admitting from an older snapshot.
      if (held?.reserved === 0 && remaining() > 0) continue;
    }
    if (!reported) {
      report(held?.held ? `Waiting for a held hosted PTY launch to settle in space ${space}.` : `Waiting for a hosted spawn to settle in space ${space}.`);
      reported = true;
    }
    if (remaining() > 0) await delay(Math.min(200, remaining()));
  }
}
