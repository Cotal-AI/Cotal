import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentHandle, AttachSession, LaunchSpec, Runtime, RuntimeReference } from "@cotal-ai/core";
import { adoptSeatSync, launchSeat, loadSeat, unsupportedTransport } from "@cotal-ai/seat";

function defaultCustodyRoot(): string {
  return join(homedir(), ".cotal", "seats");
}

/**
 * Production pty runtime on Linux: a one-shot launcher starts a detached
 * per-seat custodian, then this process holds only a proxy AgentHandle.
 * darwin/win32 throw; there is no in-process fallback.
 */
export class CustodialPtyRuntime implements Runtime {
  readonly kind = "pty" as const;

  constructor(private readonly root: string = process.env.COTAL_SEAT_ROOT ?? defaultCustodyRoot()) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    const rec = launchSeat({
      root: this.root,
      name,
      spec: { command: spec.command, args: spec.args, env: spec.env ?? {}, confirm: Boolean(spec.confirm) },
      cwd,
    });
    return adoptSeatSync(rec) as unknown as AgentHandle;
  }

  adopt(reference: RuntimeReference): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot adopt runtime kind "${reference.kind}" with pty`);
    return adoptSeatSync(loadSeat(this.root, reference.id)) as unknown as AgentHandle;
  }
}

export type { AttachSession };
