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
 * `createRuntime("pty")` does not construct this class off Linux. Spawn and
 * adopt still throw the named transport error if it is instantiated there.
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
    return this.proxy(adoptSeatSync(rec));
  }

  adopt(reference: RuntimeReference): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot adopt runtime kind "${reference.kind}" with pty`);
    return this.proxy(adoptSeatSync(loadSeat(this.root, reference.id)));
  }

  /** SeatHandle.close() is erased by the AgentHandle cast. Expose it as release() so a spare
   *  stop can drop the unix socket without optional-chaining a missing method. */
  private proxy(seat: ReturnType<typeof adoptSeatSync>): AgentHandle {
    return Object.assign(seat as unknown as AgentHandle, {
      release: () => {
        seat.close();
      },
    });
  }
}

export type { AttachSession };
