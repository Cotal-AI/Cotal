import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentHandle, AttachSession, LaunchSpec, Runtime, RuntimeReapEvidence, RuntimeReference } from "@cotal-ai/core";
import { adoptSeatSync, launchSeat, loadSeat, reapSeat, unsupportedTransport } from "@cotal-ai/seat";

function defaultCustodyRoot(): string {
  return join(homedir(), ".cotal", "seats");
}

/**
 * Production pty runtime on Linux: a one-shot launcher starts a detached
 * per-seat custodian, then this process holds only a proxy AgentHandle.
 * `createRuntime("pty")` does not construct this class off Linux. Spawn and
 * adopt still throw the named transport error if it is instantiated there.
 */
export class CustodialPtyRuntime implements Runtime {
  readonly kind = "pty" as const;
  readonly supportsRelease = true;

  constructor(private readonly root: string = process.env.COTAL_SEAT_ROOT ?? defaultCustodyRoot()) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    const rec = launchSeat({
      root: this.root,
      name,
      spec: { command: spec.command, args: spec.args, env: spec.env ?? {}, confirm: spec.confirm },
      cwd,
    });
    const seat = adoptSeatSync(rec);
    return { ...seat, release: () => seat.close() } as AgentHandle;
  }

  adopt(reference: RuntimeReference): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot adopt runtime kind "${reference.kind}" with pty`);
    const seat = adoptSeatSync(loadSeat(this.root, reference.id));
    return { ...seat, release: () => seat.close() } as AgentHandle;
  }

  async reap(reference: RuntimeReference): Promise<RuntimeReapEvidence> {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot reap runtime kind "${reference.kind}" with pty`);
    const evidence = await reapSeat(this.root, reference.id);
    return evidence.outcome === "absent" ? { outcome: "absent" } : { outcome: "reaped", detail: evidence.detail };
  }
}

export type { AttachSession };
