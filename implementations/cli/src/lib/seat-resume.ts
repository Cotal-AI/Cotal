/**
 * Admission plus restore for one preserved cut, as both destination paths run it.
 *
 * `cotal up` from a `ready` journal and `cotal up --restore <dir>` reach a preserved resume by
 * different routes and hand the same retained inventory to the same manager operation. They
 * therefore owe the seats the same thing: section 2.2's gates, the restore of section 6 step 7, and
 * the writer generation, in that order, before a manager launches. Keeping one implementation is
 * what stops the two routes from drifting into one gated path and one ungated one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { seatCheckpointDir } from "@cotal-ai/workspace";
import { admitSeatCheckpoints } from "./seat-admission.js";
import { restoreSeatCheckpoints } from "./seat-restore.js";
import { c } from "../ui.js";

/** The fields these paths read off one retained inventory entry. The manager owns
 *  `ManagerResumeAgent`; implementations never depend on each other, so the coordinator states the
 *  shape it actually reads. */
interface RetainedSeat {
  name?: string;
  identity?: { lifecycleUid?: string };
  launch?: { cwd?: string; sessionId?: string; source?: { configPath: string } };
}

/** One stale checkpoint the operator deliberately admitted, for the resume journal. */
export interface StaleCheckpointConsent {
  readonly name: string;
  readonly capturedAt: string;
  readonly ageMs: number;
  readonly horizonMs: number;
}

/** This host's current revision for a seat's launch config, or undefined when the file is gone.
 *  A missing profile is not a mismatch: the manager's own relaunch check reports that separately,
 *  and inventing a digest here would turn an absent file into a false profile refusal. */
function digestFileOrUndefined(path: string): string | undefined {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return undefined; }
}

/**
 * Run section 2.2's gates over every seat checkpoint the cut wrote, restore the captured bytes,
 * then take custody of each seat.
 *
 * Gate 2 is told which lifecycle uids are live. On these paths that set is empty and the reason is
 * structural rather than an omission: a preserved resume is only reached from a `ready` journal,
 * which `down --preserve-state` publishes after it has proven every recorded process stopped and
 * the exact recorded endpoint unreachable. There is no roster to consult because there is no
 * broker. A destination that resumes against a live space supplies the roster instead.
 *
 * The restore runs inside the admission, after every gate and before any generation is claimed, so
 * a refusal costs nothing: no tree has been promoted, no claim has been made, nothing has started.
 */
export function admitAndRestoreSeatCheckpoints(
  root: string,
  space: string,
  attemptId: string,
  values: { "accept-stale-checkpoint"?: boolean },
  inventory: unknown,
): StaleCheckpointConsent[] {
  // The checkpoints of the CUT this resume is consuming, named by that cut's attempt id. A resume
  // must not admit an older cut's artifacts: they describe a tree and a transcript this inventory
  // is not about to restore.
  const checkpointDir = seatCheckpointDir(root, attemptId);
  // The seats this resume is about to hand the manager. Admission is reconciled against this set,
  // because "no checkpoint" and "no seat" look identical to a reader of the checkpoint directory
  // alone, and only one of them is safe.
  const retainedAgents = ((inventory as { agents?: RetainedSeat[] }).agents ?? []);
  const retained = new Map(retainedAgents.map((agent) => [agent.name ?? "", agent]));
  const admitted = admitSeatCheckpoints({
    root,
    checkpointDir,
    space,
    // This host's current revision for each seat's launch source, digested from the same file the
    // manager re-digests before it relaunches. Passing it is what makes gate 2's profile half a
    // decision: without it the gate has nothing to compare and the override decides nothing.
    currentProfileConfigSha256: (name) => {
      const source = retained.get(name)?.launch?.source;
      return source ? digestFileOrUndefined(source.configPath) : undefined;
    },
    liveLifecycleUids: new Set<string>(),
    // Reconcile inside the admission, after the gates and BEFORE any generation is claimed. A
    // retained seat with no checkpoint would otherwise resume with no gate run and no custody
    // claimed, and checking after the claims had landed would leave the earlier seats' exclusive
    // creates behind, so the retry over a repaired checkpoint set could never make them again.
    requireCovered: (admittedNames) => {
      const covered = new Set(admittedNames);
      const uncovered = retainedAgents.map((agent) => agent.name ?? "").filter((name) => !covered.has(name));
      if (uncovered.length)
        throw new Error(`preserved resume is refused: retained seat(s) ${uncovered.map((name) => JSON.stringify(name)).join(", ")} have no admitted checkpoint under ${checkpointDir}; a seat cannot resume without passing the admission gates and claiming its writer generation`);
    },
    ...(values["accept-stale-checkpoint"] ? { acceptStale: true } : {}),
    // The restore, between the gates and custody. Every admitted seat's captured bytes land in a
    // staging directory beside its cwd and are promoted only once every seat has staged; a refusal
    // here leaves every live cwd as it was and claims no generation, like a gate failure.
    beforeCustody: (staged) => {
      // THE INCARNATION RECONCILIATION, AND IT RUNS BEFORE THE RESTORE TOUCHES ANYTHING.
      //
      // This compares the checkpoint's recovered `lifecycleUid` against the one the inventory this
      // resume is about to hand the manager carries, and it used to run after the whole admission
      // returned. By then the restore had already moved each live `cwd` aside and promoted another
      // seat's tree over it, and the generation had been claimed under the checkpoint's uid, so the
      // refusal arrived after the two irreversible steps it exists to prevent. A mismatch means the
      // checkpoint describes a different incarnation than the seat being resumed, which is the last
      // moment where refusing is still free.
      for (const seat of staged) {
        const expected = retained.get(seat.checkpoint.name)?.identity?.lifecycleUid ?? "";
        if (expected && expected !== seat.checkpoint.lifecycleUid)
          throw new Error(`seat ${seat.checkpoint.name}: checkpoint records lifecycle ${seat.checkpoint.lifecycleUid}, the retained inventory says ${expected}`);
      }
      restoreSeatCheckpoints({
        root,
        seats: staged.map((seat) => {
          const entry = retained.get(seat.checkpoint.name);
          const cwd = entry?.launch?.cwd;
          if (!cwd)
            throw new Error(`preserved resume is refused: retained seat ${JSON.stringify(seat.checkpoint.name)} records no launch cwd, so its checkpoint has no working tree to restore into`);
          const sessionId = entry?.launch?.sessionId;
          return {
            name: seat.checkpoint.name,
            directory: seat.directory,
            checkpoint: seat.checkpoint,
            cwd,
            ...(sessionId ? { inventorySessionId: sessionId } : {}),
          };
        }),
        onPromoted: (seat) => {
          console.log(c.dim(`  restored working tree: ${seat.name} -> ${seat.cwd}${seat.superseded ? ` (previous tree kept at ${seat.superseded})` : ""}`));
        },
      });
    },
  });

  for (const seat of admitted) {
    console.log(c.dim(`  admitted checkpoint: ${seat.checkpoint.name} (${seat.checkpoint.session.continuity}) at generation ${seat.generation}`));
    if (seat.staleOverrideAgeMs !== undefined)
      console.log(c.yellow(`  stale checkpoint admitted by --accept-stale-checkpoint: ${seat.checkpoint.name} is ${seat.staleOverrideAgeMs}ms past capture, horizon ${seat.checkpoint.recencyHorizonMs}ms`));
  }
  return admitted
    .filter((seat) => seat.staleOverrideAgeMs !== undefined)
    .map((seat) => ({
      name: seat.checkpoint.name,
      capturedAt: seat.checkpoint.capturedAt,
      ageMs: seat.staleOverrideAgeMs as number,
      horizonMs: seat.checkpoint.recencyHorizonMs,
    }));
}
