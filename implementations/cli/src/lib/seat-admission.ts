/**
 * Admission: what a destination decides before it launches a preserved seat.
 *
 * Section 2.2's three gates in order, then section 3.3's custody transfer step 4. The order is
 * load-bearing. Gate 1 is about the bytes, gate 2 about authority, gate 3 about usefulness, and
 * gate 3 may have an override only because gate 2 does not. The generation is claimed after all
 * three pass and before anything starts, so a lost claim costs nothing.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  admitSeatCheckpointRecency,
  advanceSeatWriterGeneration,
  assertSeatCheckpointIdentity,
  assertSeatCheckpointIntegrity,
  readSeatCheckpoint,
  type SeatCheckpoint,
} from "@cotal-ai/workspace";

export interface SeatAdmission {
  readonly name: string;
  readonly checkpoint: SeatCheckpoint;
  /** The generation this destination claimed. Always the recorded one plus one. */
  readonly generation: number;
  /** Set when gate 3 admitted a checkpoint past its horizon under explicit operator consent. */
  readonly staleOverrideAgeMs?: number;
}

export interface AdmitSeatsOptions {
  /** The destination workspace root, where the claimed generation is persisted. */
  readonly root: string;
  /** The directory the cut wrote, holding one subdirectory per seat. */
  readonly checkpointDir: string;
  readonly space: string;
  /** Principals the destination believes are live, so gate 2 can refuse adopting one. */
  readonly liveLifecycleUids: ReadonlySet<string>;
  /** This destination's current profile revision for a seat, by name. Returning undefined means
   *  the destination has no revision to compare, which gate 2 treats as nothing to refuse rather
   *  than as a match. */
  readonly currentProfileConfigSha256?: (name: string) => string | undefined;
  /** `--accept-stale-checkpoint`. Consent for gate 3 only; gate 2 has no override. */
  readonly acceptStale?: boolean;
  /** `--accept-recorded-profile`. Resume under the checkpoint's profile revision deliberately. */
  readonly acceptRecordedProfile?: boolean;
  readonly now?: number;
}

/**
 * Admit every checkpoint the cut wrote and take custody of each seat. Throws on the first refusal:
 * a destination that launched some seats and refused others would be a half-transferred custody,
 * which is the state this whole mechanism exists to prevent.
 */
export function admitSeatCheckpoints(options: AdmitSeatsOptions): SeatAdmission[] {
  if (!existsSync(options.checkpointDir)) return [];
  const admitted: SeatAdmission[] = [];
  for (const name of readdirSync(options.checkpointDir).sort()) {
    const directory = join(options.checkpointDir, name);
    if (!existsSync(join(directory, "checkpoint.json"))) continue;
    const checkpoint = readSeatCheckpoint(directory);

    // Gate 1, integrity. Failure here is a refusal and no other gate is consulted.
    assertSeatCheckpointIntegrity(directory, checkpoint);

    // Gate 2, identity. No override.
    const current = options.currentProfileConfigSha256?.(checkpoint.name);
    assertSeatCheckpointIdentity(checkpoint, {
      space: options.space,
      lifecycleUidIsLive: options.liveLifecycleUids.has(checkpoint.lifecycleUid),
      ...(current !== undefined ? { profileConfigSha256: current } : {}),
      ...(options.acceptRecordedProfile ? { acceptRecordedProfile: true } : {}),
    });

    // Gate 3, recency.
    const recency = admitSeatCheckpointRecency(checkpoint, {
      now: options.now ?? Date.now(),
      ...(options.acceptStale ? { acceptStale: true } : {}),
    });

    // Custody. Exclusive create on the SUCCESSOR value, before anything launches. A lost create
    // means another destination is already claiming this seat, and it refuses rather than adopting.
    const generation = checkpoint.generation + 1;
    advanceSeatWriterGeneration(options.root, {
      space: checkpoint.space,
      name: checkpoint.name,
      // The recorded uid is REUSED, never minted: the durables are keyed by it.
      lifecycleUid: checkpoint.lifecycleUid,
      generation,
    });

    admitted.push({
      name,
      checkpoint,
      generation,
      ...(recency.admitted === "override" ? { staleOverrideAgeMs: recency.ageMs } : {}),
    });
  }
  return admitted;
}
