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
  assertSeatCheckpointIdentity,
  assertSeatCheckpointIntegrity,
  claimSeatWriterGenerations,
  readSeatCheckpoint,
  type SeatCheckpoint,
} from "@cotal-ai/workspace";

export interface SeatAdmission {
  readonly name: string;
  /** The directory this checkpoint was read from, so a consumer of the captured bytes does not
   *  rebuild the path the gates already resolved. */
  readonly directory: string;
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
  /** The caller's own admissibility condition, run over the seat names the cut actually wrote,
   *  before any gate and before any generation is claimed. It throws to refuse the whole set. */
  readonly requireCovered?: (checkpointedNames: readonly string[]) => void;
  /** Run once, after every gate has passed over every checkpoint and before a single generation is
   *  claimed. This is where the destination consumes the captured bytes: a refusal here must cost
   *  nothing, and it does, because no claim has been made and no process has started. It throws to
   *  refuse the whole set. */
  readonly beforeCustody?: (admitted: readonly SeatAdmission[]) => void;
  readonly now?: number;
}

/**
 * Admit every checkpoint the cut wrote and take custody of each seat.
 *
 * Three phases, and the order is the point. Coverage is settled first, from the directory listing
 * alone, so a caller's own condition (a retained seat with no checkpoint) refuses before a single
 * byte is digested. Then all three gates run over every checkpoint, collecting admissions and
 * claiming nothing. Only when the whole set has passed does custody advance.
 *
 * Claiming inside the gate loop made a refusal expensive: a later seat's refusal left an earlier
 * seat's generation already taken by exclusive create, so the retry that was supposed to cost
 * nothing lost that claim and could never make it again. A failure anywhere now leaves every
 * generation unclaimed.
 */
export function admitSeatCheckpoints(options: AdmitSeatsOptions): SeatAdmission[] {
  const directories = existsSync(options.checkpointDir)
    ? readdirSync(options.checkpointDir).sort()
        .filter((name) => existsSync(join(options.checkpointDir, name, "checkpoint.json")))
    : [];

  // Phase 1, coverage, before any gate. A missing checkpoint is not a gate failure and must not
  // wait behind one.
  options.requireCovered?.(directories);

  // Phase 2, the gates, over every checkpoint. Nothing is claimed here.
  const decided: SeatAdmission[] = [];
  for (const name of directories) {
    const directory = join(options.checkpointDir, name);
    const checkpoint = readSeatCheckpoint(directory);

    // Gate 1, integrity. Failure here is a refusal and no other gate is consulted.
    assertSeatCheckpointIntegrity(directory, checkpoint);

    // Gate 2, identity. No override.
    const current = options.currentProfileConfigSha256?.(checkpoint.name);
    assertSeatCheckpointIdentity(checkpoint, {
      space: options.space,
      lifecycleUidIsLive: options.liveLifecycleUids.has(checkpoint.lifecycleUid),
      ...(current !== undefined ? { profileConfigSha256: current } : {}),
    });

    // Gate 3, recency.
    const recency = admitSeatCheckpointRecency(checkpoint, {
      now: options.now ?? Date.now(),
      ...(options.acceptStale ? { acceptStale: true } : {}),
    });

    decided.push({
      name,
      directory,
      checkpoint,
      // The successor value this seat will claim in phase 3, not a claim yet.
      generation: checkpoint.generation + 1,
      ...(recency.admitted === "override" ? { staleOverrideAgeMs: recency.ageMs } : {}),
    });
  }

  // Between the gates and custody, deliberately. The restore runs over checkpoints that have all
  // passed, so it never touches a working tree for a set that was going to be refused; and it runs
  // before any claim, so its own refusal leaves every generation unclaimed like any gate failure.
  options.beforeCustody?.(decided);

  // Phase 3, custody, once the whole set is admissible. Exclusive create on the SUCCESSOR value,
  // before anything launches. A lost create means another destination is already claiming that
  // seat, and the whole set is refused rather than adopting the winner.
  //
  // The set is claimed through one helper so it is all-or-nothing: each create is its own fence,
  // so a later one can still lose after every gate passed, and a claim left behind would consume
  // the retry over this same admissible set.
  claimSeatWriterGenerations(options.root, decided.map((seat) => ({
    space: seat.checkpoint.space,
    name: seat.checkpoint.name,
    // The recorded uid is REUSED, never minted: the durables are keyed by it.
    lifecycleUid: seat.checkpoint.lifecycleUid,
    generation: seat.generation,
  })));
  return decided;
}
