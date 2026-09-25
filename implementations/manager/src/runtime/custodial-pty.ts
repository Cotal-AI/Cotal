import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentHandle, AttachSession, LaunchSpec, RuntimeReference } from "@cotal-ai/core";
import type { CustodialRuntime, RuntimeReapEvidence } from "./index.js";
import { adoptSeatSync, launchSeat, loadSeat, reapSeat, seatId, unsupportedTransport, type SeatRecord } from "@cotal-ai/seat";

function defaultCustodyRoot(): string {
  return join(homedir(), ".cotal", "seats");
}

/**
 * Production pty runtime on Linux: a one-shot launcher starts a detached
 * per-seat custodian, then this process holds only a proxy AgentHandle.
 * `createRuntime("pty")` does not construct this class off Linux. Spawn and
 * adopt still throw the named transport error if it is instantiated there.
 */
export class CustodialPtyRuntime implements CustodialRuntime {
  readonly kind = "pty" as const;
  readonly supportsRelease = true;
  /**
   * Private cache of active SeatRecords keyed by custody reference id, populated on spawn and adopt
   * and pruned on reap or release. When a managed seat cleanly exits, its custodian unlinks the
   * on-disk custody file; this pinned record allows reapSeat to prove the kernel start identities and
   * process group are gone without requiring the file to linger. An unadopted reference without a
   * pinned record falls back to fail-closed absent handling (RuntimeReapUnproven).
   */
  private readonly records = new Map<string, SeatRecord>();

  constructor(private readonly root: string = process.env.COTAL_SEAT_ROOT ?? defaultCustodyRoot()) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /** Mint the custody id for a seat about to be launched. Nothing is written here: the id names a
   *  directory the custodian creates at launch, so a reserved id that is never spawned reaps as
   *  `absent`. The manager records this reference durably before it calls {@link spawn}. */
  reserve(): RuntimeReference {
    if (process.platform !== "linux") throw unsupportedTransport();
    return { kind: this.kind, id: seatId() };
  }

  spawn(name: string, spec: LaunchSpec, cwd: string, reference?: RuntimeReference): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference !== undefined && reference.kind !== "pty")
      throw new Error(`cannot spawn under runtime kind "${reference.kind}" with pty`);
    const rec = launchSeat({
      root: this.root,
      name,
      spec: { command: spec.command, args: spec.args, env: spec.env ?? {}, confirm: spec.confirm },
      cwd,
      ...(reference ? { id: reference.id } : {}),
    });
    this.records.set(rec.id, rec);
    const seat = adoptSeatSync(rec);
    return {
      ...seat,
      release: () => {
        this.records.delete(rec.id);
        seat.close();
      },
    } as AgentHandle;
  }

  adopt(reference: RuntimeReference): AgentHandle {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot adopt runtime kind "${reference.kind}" with pty`);
    const rec = loadSeat(this.root, reference.id);
    this.records.set(rec.id, rec);
    const seat = adoptSeatSync(rec);
    return {
      ...seat,
      release: () => {
        this.records.delete(rec.id);
        seat.close();
      },
    } as AgentHandle;
  }

  async reap(reference: RuntimeReference): Promise<RuntimeReapEvidence> {
    if (process.platform !== "linux") throw unsupportedTransport();
    if (reference.kind !== "pty") throw new Error(`cannot reap runtime kind "${reference.kind}" with pty`);
    const pinnedRecord = this.records.get(reference.id);
    const evidence = await reapSeat(this.root, reference.id, { pinnedRecord });
    if (evidence.outcome === "reaped") {
      this.records.delete(reference.id);
    }
    return evidence.outcome === "absent" ? { outcome: "absent" } : { outcome: "reaped", detail: evidence.detail };
  }
}

export type { AttachSession };
