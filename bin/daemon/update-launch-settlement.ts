import { setTimeout as delay } from "node:timers/promises";
import { withIdpSessionDir } from "@cotal-ai/auth";
import { displayCmd } from "@cotal-ai/cli/self-exec";
import { homeCotalDir, resolveControlTarget, shellPath } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { inspectHostedLaunches } from "./client.js";
import type { DaemonPaths } from "./endpoint.js";
import type { HostedLaunches } from "./protocol.js";

export class HostedLaunchSettlementTimeout extends Error {
  constructor(message: string, readonly pending: "ordinary" | "held") { super(message); }
}

// No readiness field is needed on the Manager wire. Cover the longest shipped connector
// readiness window (Jcode, three minutes), including against a Manager without inspection.
const ORDINARY_LAUNCH_WAIT_MS = 180_000;
const HELD_LAUNCH_WAIT_MS = 15_000;

type LaunchStatus = { instanceId?: unknown; agentCount?: number; custody?: string; stopImpact?: { reservedLaunches?: number } };

export function readSettledHostedStatus(paths: DaemonPaths, space: string, instanceId: string, retry: "update" | "update --self", report: (line: string) => void, deadline?: number): Promise<LaunchStatus> {
  return withIdpSessionDir(homeCotalDir(), async () => {
    const target = await resolveControlTarget({ space }, "control-caller-privileged", instanceId, { onRefusal: "throw", readOnly: true });
    const client = { versionSkew: (text: string) => text, roster: async () => [] };
    return waitForHostedLaunches(space, instanceId, async timeoutMs => {
      const reply = await askManager(client, space, target.server, "managerStatus", undefined, target.auth, "owner", timeoutMs, { instanceId });
      if (!reply.ok) throw new Error(reply.error ?? "hosted Manager status did not answer");
      return reply.data as LaunchStatus;
    }, timeoutMs => inspectHostedLaunches(paths, space, instanceId, timeoutMs), retry, report, undefined, deadline);
  });
}

/** Wait for reservations, never for steady-state seats. A later restart still needs its own fence. */
export async function waitForHostedLaunches(
  space: string, instanceId: string, read: (timeoutMs: number) => Promise<LaunchStatus>,
  inspect: (timeoutMs: number) => Promise<HostedLaunches | undefined>,
  retry: "update" | "update --self", report: (line: string) => void,
  clock = { now: () => performance.now(), sleep: (ms: number) => delay(ms) },
  outerDeadline = Infinity,
): Promise<LaunchStatus> {
  const deadline = Math.min(outerDeadline, clock.now() + ORDINARY_LAUNCH_WAIT_MS);
  let heldDeadline = deadline;
  let reported = false;
  let launches: HostedLaunches | undefined;
  let privateSupported = true;
  const remaining = () => Math.ceil(Math.min(deadline, heldDeadline) - clock.now());
  const cli = displayCmd();
  const retryCommand = `\`${cli} ${retry}\``;
  const timedOut = () => {
    const named = launches?.held && launches.held === launches.reserved ? `${launches.names.map(name => JSON.stringify(name)).join(", ")}${launches.held > launches.names.length ? ` and ${launches.held - launches.names.length} more` : ""}` : undefined;
    return new HostedLaunchSettlementTimeout(named
      ? `Hosted PTY launch still held in space ${space}: ${named}. No installed packages were changed. Save work in this space before clearing the hold: \`${cli} daemon service-disconnect --space ${shellPath(space)}\` stops its hosted Manager and seats. Then retry ${retryCommand}.`
      : `A hosted spawn in space ${space} is still in progress. No installed packages were changed. When it finishes, retry ${retryCommand}.`, named ? "held" : "ordinary");
  };
  for (;;) {
    if (remaining() <= 0) throw timedOut();
    if (!launches?.reserved) {
      const status = await read(Math.min(3_000, remaining()));
      if (remaining() <= 0) throw timedOut();
      if (status?.instanceId !== instanceId) throw new Error(`Manager ${space} identity changed while checking launch settlement`);
      const reserved = status.stopImpact?.reservedLaunches;
      if (reserved === undefined || reserved === 0) return status;
      if (!Number.isSafeInteger(reserved) || reserved < 0) throw new Error(`Manager ${space} returned an invalid launch reservation count`);
    }
    if (privateSupported && remaining() > 0) {
      launches = await inspect(Math.min(3_000, remaining()));
      privateSupported = launches !== undefined;
      heldDeadline = launches?.held && launches.held === launches.reserved
        ? Math.min(heldDeadline, clock.now() + HELD_LAUNCH_WAIT_MS) : deadline;
      // The private observation is newer than the public status. Re-read the status for the
      // settled seat inventory rather than admitting from an older snapshot.
      if (launches?.reserved === 0 && remaining() > 0) continue;
    }
    if (!reported) {
      report(launches?.held ? `Waiting for a held hosted PTY launch to settle in space ${space}.` : `Waiting for a hosted spawn to settle in space ${space}.`);
      reported = true;
    }
    // An older daemon needs a fresh broker connection for each status read. Keep it below
    // the default 60-per-minute actor limit rather than turning a slow spawn into a rate refusal.
    if (remaining() > 0) await clock.sleep(Math.min(privateSupported ? 200 : 2_000, remaining()));
  }
}
