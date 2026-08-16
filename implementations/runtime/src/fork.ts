/**
 * Fork a run from a named step: the §8.5 cut, and the two things a fork must not re-decide.
 *
 * `fork(runId, fromStepKey)` is the repair verb. It does not roll the parent back — the parent is
 * untouched — it starts a NEW run that owns the parent's history up to a named step and re-runs from
 * there. Two decisions inside that sentence carry the whole design:
 *
 * **The cut is computed by a DRY WALK IN MIGRATION MODE, and the mode is load-bearing rather than a
 * default.** A resume's replay short-circuits a settled scope: it takes the scope's recorded outcome
 * and never walks its branches, so every entry underneath it is accounted for in one step. That is
 * exactly right for a resume, which only needs to get past it, and exactly wrong here — the step a
 * caller wants to cut at can be INSIDE such a scope, and a walk that never entered it would either
 * miss the cut entirely or sweep entries that come after the cut point into the prefix. A fork with a
 * silently-too-large prefix is the worst available outcome: it looks like a fork, drives like a fork,
 * and has already replayed the work the caller forked to avoid.
 *
 * **The prefix inherits the parent's pins UNCHANGED, seed included.** The child gets a new run id and
 * `resolvePins` defaults a seed to the run id, so re-resolving pins for the child would reseed it —
 * and a reseeded prefix redecides every pure draw inside history it was supposed to be copying. A
 * parent that drew `left` would give a child that draws `right`, and nothing would diverge, because a
 * `pick` is pure and no entry records it. So the parent's `RunPins` are copied verbatim; the fresh
 * derivation begins at the frontier, which is what "fork" means.
 *
 * What this file does NOT do, named rather than implied:
 *   - It does not respawn agents. §8.5's `onFork` mints a fresh agent at the frontier, and `spawn`
 *     rides the durable-action machinery this host does not have, so a cut containing a spawn is
 *     REFUSED (L5019) rather than copied and hoped about.
 *   - It does not cut worktree branches (§9). There is no worktree plane in this tree; a caller that
 *     asks for one is refused rather than told a branch exists.
 *   - It does not record LINEAGE. The child's run record cannot say it is a fork of anything: a run's
 *     spec has no such field, and inventing one is a §17 scope change of the kind the `migration`
 *     record went through a ruling for. `commitFork` reports `lineageRecorded: false` so the gap is
 *     something a caller reads rather than something a reader has to notice.
 */
import type { KV } from "@nats-io/kv";
import { createRunSpec, readRunRecord } from "@cotal-ai/core";
import {
  Journal,
  JournalReadOnlyError,
  journalEntryKeyString,
  run as runProgram,
  RunDivergence,
  UnwalkableScope,
  stepKeyString,
  type EffectContext,
  type EffectHandler,
  type JournalEntry,
  type JournalInit,
  type JournalStore,
  type LookupVerdict,
  type RunPins,
  type StepKey,
} from "@cotal-ai/lang";

/** The journal kinds that open a scope, i.e. whose entry can ENCLOSE a cut point. */
const SCOPE_KINDS = new Set<string>(["parallel", "race", "fanOut", "conclave"]);

/** One reason a fork was refused, carrying the code a reader repairs against (§11). */
export interface ForkRefusal {
  readonly code: string;
  readonly step?: string;
  readonly why: string;
}

export interface ForkPlan {
  readonly parent: string;
  readonly child: string;
  readonly at: number;
  readonly actor: string;
  /** The step the child re-runs FROM. Never part of the cut: the cut is what happened before it. */
  readonly fromStep: string;
  /** The parent's pins, verbatim — what the child must be created under, not what it would resolve. */
  readonly pins: RunPins;
  /** The entries the child inherits as history, in the parent's recorded order. */
  readonly cut: readonly JournalEntry[];
  readonly admissible: boolean;
  readonly refusals: readonly ForkRefusal[];
}

export interface ForkRequest {
  readonly parent: string;
  /** The child's run id. Allocated by the caller, because minting an id is not this file's decision. */
  readonly child: string;
  /** A journal key string, e.g. `/checkpoint:approve#0`. Not a sequence number: it survives edits. */
  readonly fromStepKey: string;
  /** The program the parent was running. */
  readonly source: string;
  readonly entries: readonly JournalEntry[];
  /** Read back from the parent's run record. Never re-derived: see the header. */
  readonly pins: RunPins;
  readonly actor: string;
  readonly now: () => number;
  readonly file?: string;
  /**
   * §8.5's `newProgramHash`. Accepted only to be REFUSED: the run record carries no program hash to
   * pin (§17 delta 2, deliberately not invented in slice (b2)), so a fork "pinned to" one would
   * record nothing at all and the caller would have been told it happened.
   */
  readonly newProgramHash?: string;
  /** §8.5 step 4. There is no worktree plane in this tree, so asking for one is refused. */
  readonly worktreeBranches?: boolean;
}

/** The walk reached the step the caller wants to cut at. Not an error: it is where the cut ENDS. */
export class CutReached extends Error {
  constructor(readonly step: string) {
    super(`the dry walk reached the cut at ${step}`);
    this.name = "CutReached";
  }
}

/**
 * A read-only journal that stops the walk when it first LOOKS UP a named step.
 *
 * Before delegating, never after: `Journal.lookup` marks a key consumed as its first act, so a stop
 * placed after the delegation would put the cut step itself into the prefix — and the child would
 * then replay the very step it was forked to re-run.
 *
 * Exported because the fork's correctness claim is about WHICH WALK produced the cut, and a suite
 * that cannot run the wrong walk cannot show the right one is different from it.
 */
export class CutJournal extends Journal {
  constructor(
    init: JournalInit,
    private readonly cutAt: string,
  ) {
    super(init);
  }

  override lookup(key: StepKey, inputHash: string): LookupVerdict {
    if (stepKeyString(key) === this.cutAt) throw new CutReached(this.cutAt);
    return super.lookup(key, inputHash);
  }
}

/** A handler that performs nothing: the cut is computed from records, never by doing anything. */
function dryHandler(now: () => number): EffectHandler {
  const stop = (_req: unknown, ctx: EffectContext): never => {
    throw new ForkFrontier(stepKeyString(ctx.key));
  };
  return {
    now,
    spawn: stop, turn: stop, ask: stop, checkpoint: stop, sleep: stop,
    wait: stop, notify: stop, monitor: stop, openConclave: stop, closeConclave: stop,
  } as unknown as EffectHandler;
}

/** The walk ran out of records before it reached the cut. The caller named a step this run never got
 *  to, which is a different failure from naming one it never recorded. */
class ForkFrontier extends Error {
  constructor(readonly step: string) {
    super(`the dry walk reached the frontier at ${step}`);
    this.name = "ForkFrontier";
  }
}

/**
 * Compute §8.5's cut. Reads; never writes.
 *
 * The plan is the product whether or not the fork is admissible — a refused fork owes the caller the
 * code and the step, because that is what makes the next attempt a repair rather than a guess.
 */
export async function planFork(req: ForkRequest): Promise<ForkPlan> {
  const refusals: ForkRefusal[] = [];

  if (req.newProgramHash !== undefined) {
    refusals.push({
      code: "L5002",
      why: "a fork onto a new program would have to pin its hash on the child's run record, and a run's spec carries no program hash (§17 delta 2 is declared and unbuilt). Refused rather than accepted and dropped.",
    });
  }
  if (req.worktreeBranches === true) {
    refusals.push({
      code: "L5019",
      why: "§8.5 gives a fork its own worktree branches cut from the parent's branch head, and there is no worktree plane in this tree to cut one from",
    });
  }

  const journal = new CutJournal(
    { run: req.parent, entries: req.entries, readOnly: true },
    req.fromStepKey,
  );

  // THE CALLER'S LIST IS AN APPEND LOG, and every step in it appears at least twice.
  //
  // The stream is append-only: settling appends a second record rather than editing the first, so a
  // completed step is a pending record AND a settled one. `RunJournalAppender.steps()` replays every
  // step record in order and the driver seeds a journal straight from it, which is the only shape a
  // real caller holds — this file's own suite was building a KEYED view with `Journal.entries()` and
  // was therefore blind to it. Filtering `req.entries` put both rows of every copied step into the
  // prefix, and `commitFork` COPIES the prefix, so the doubling was written to the child's durable
  // stream as real records. Silent, with every key correct and simply two of each.
  //
  // The fold is the journal's, not a second copy of the rule: the entries below are its keyed view,
  // last write per step in the order the run performed them.
  const entries = journal.entries();

  const recorded = entries.some((e) => journalEntryKeyString(e) === req.fromStepKey);
  if (!recorded) {
    refusals.push({
      code: "L5017",
      step: req.fromStepKey,
      why: "the journal has no entry under this key; a fork cuts at a step the parent actually recorded, and a key that names nothing would silently cut at the end of history",
    });
  }

  let reached = false;
  try {
    await runProgram(req.source, {
      runId: req.parent,
      handler: dryHandler(req.now),
      journal,
      // MIGRATION MODE. See the header: a resume's short-circuit would carry a settled scope's whole
      // subtree into the prefix, and the entries it swept in are precisely the ones after the cut.
      migration: true,
      pins: req.pins,
      ...(req.file !== undefined ? { file: req.file } : {}),
    });
  } catch (e) {
    const err = unwrapCut(e);
    if (err instanceof CutReached) {
      reached = true;
    } else if (err instanceof RunDivergence) {
      refusals.push({
        code: "L5001",
        step: err.stepKey,
        why: "the source diverged from the recorded journal before the cut was reached, so what the prefix contains is not decided; migrate the run or fork on the source it recorded",
      });
    } else if (err instanceof UnwalkableScope) {
      refusals.push({
        code: "L5014",
        step: err.scopeKey,
        why: `the walk could not enter a scope on the way to the cut: ${err.message}`,
      });
    } else if (!(err instanceof ForkFrontier) && !(err instanceof JournalReadOnlyError)) {
      throw e;
    }
  }

  const orphaned = new Set(journal.orphans().map((e) => journalEntryKeyString(e)));

  // THE FRONTIER PROJECTION. A scope that ENCLOSES the cut point must not be copied as settled.
  //
  // The dry walk runs in migration mode, which descends into a recorded scope rather than
  // short-circuiting it, so the cut point inside a branch is reached and everything before it is
  // consumed — including the scope's own entry. The CHILD, though, replays in RESUME mode, where a
  // settled scope entry is taken wholesale: it reads the recorded result, never re-enters, and its
  // first live step lands after the whole combinator. The child then never re-runs the step it was
  // forked for, and the recorded result it inherits already contains the answer for the branch the
  // caller wanted re-decided. Admissible, no refusal, wrong child — the worst shape available.
  //
  // Dropping the enclosing entry makes the child re-enter the combinator: sibling branches replay
  // from their own entries, which are still in the cut, and the branch holding the cut point runs
  // live from it. That is what a fork means here.
  const enclosing = entries.filter((e) => {
    const k = journalEntryKeyString(e);
    return SCOPE_KINDS.has(e.kind) && req.fromStepKey.startsWith(`${k}/b:`);
  });

  // Re-entering is only sound for a scope whose branches all RUN. A `race` decided a winner, and a
  // child that re-enters would race again — re-deciding, on a fresh handler, something the parent
  // recorded. That is not a fork of the run, it is a different run. Refused rather than re-raced,
  // and refused rather than copied-as-settled, because both of those are silent.
  for (const e of enclosing) {
    if (e.kind === "parallel" || e.kind === "fanOut") continue;
    refusals.push({
      code: "L5020",
      step: journalEntryKeyString(e),
      why: `the cut is inside a \`${e.kind}\`, whose outcome this run already decided. Re-entering it would decide it again on a fresh handler, and copying it settled would make the child skip the step it was forked to re-run. Fork at a step outside the ${e.kind}, or at the ${e.kind} itself.`,
    });
  }

  // L5018 says one specific thing: the program's own path does not arrive at this step. When the
  // walk stopped for a reason of its OWN — it diverged (L5001), it could not enter a scope (L5014),
  // or the step sits inside a scope whose losing arms the walk does not enter at all (L5020) — the
  // path may well arrive there and that sentence is FALSE. Emitting it beside the true refusal is
  // worse than emitting nothing: both codes are actionable and they prescribe opposite repairs, so
  // the caller re-keys a step that was correct all along instead of forking before the conclave. A
  // refusal set is only a repair instruction if every code in it is true.
  //
  // L5020 is in that set for a reason worth stating: a `race` LOSER's step is recorded, settled, and
  // genuinely performed by the parent — every arm of a race runs — yet the migration walk enters
  // only the recorded winner, so `reached` is false for a key the program does reach. L5018 there
  // told the caller their program does not go somewhere it does go.
  //
  // This runs after the projection because the gate has to be able to SEE L5020; a `some()` over a
  // refusal set that has not been filled yet is a check that cannot fail.
  const stoppedForAnotherReason = refusals.some(
    (r) => r.code === "L5001" || r.code === "L5014" || r.code === "L5020",
  );
  if (!reached && recorded && !stoppedForAnotherReason) {
    refusals.push({
      code: "L5018",
      step: req.fromStepKey,
      why: "the step is recorded, but this replay never reached it — the program's own path does not arrive there. A cut that was never reached is the whole journal, and copying the whole journal is not a fork.",
    });
  }

  const projected = new Set(enclosing.map((e) => journalEntryKeyString(e)));
  // A REFUSED PLAN CARRIES NO CUT. An unreached walk already returned nothing, on the ground that a
  // plausible-looking prefix is worse than an empty one; a plan that was reached and then refused
  // has exactly the same hazard and had exactly the opposite behaviour. A caller reading `cut`
  // without reading `admissible` got something usable-shaped out of a fork that will not happen.
  const cut =
    reached && refusals.length === 0
      ? entries.filter((e) => {
          const k = journalEntryKeyString(e);
          return !orphaned.has(k) && !projected.has(k);
        })
      : [];

  // §8.5 step 3, at plan time rather than at commit time. `onFork: "respawn"` mints a fresh agent at
  // the frontier and `"adopt"` shares the parent's; both name a durable agent handle, and `spawn`
  // rides the durable-action machinery this host does not have. Copying the prefix anyway would
  // produce a child that owns turns taken by an agent it can neither address nor replace.
  for (const e of cut) {
    if (e.kind !== "spawn") continue;
    refusals.push({
      code: "L5019",
      step: journalEntryKeyString(e),
      why: "the cut contains a spawn, and a fork must respawn or adopt that agent at the frontier; both ride the durable-action machinery an agent handle comes from, which has not landed on this host. Fork at a step before the spawn, or wait for it.",
    });
  }

  return {
    parent: req.parent,
    child: req.child,
    at: req.now(),
    actor: req.actor,
    fromStep: req.fromStepKey,
    pins: req.pins,
    cut,
    admissible: refusals.length === 0,
    refusals,
  };
}

export interface ForkCommitResult {
  readonly child: string;
  readonly copied: number;
  /**
   * Always false, and reported rather than omitted.
   *
   * The child's record cannot say it is a fork of anything: `RunSpecValue` has no lineage field, and
   * adding one — or a `fork` record kind beside `migration` — is a §17 scope change that belongs to a
   * ruling rather than to this file. A caller that needs the lineage has it in the {@link ForkPlan}
   * it passed; nothing durable carries it yet.
   */
  readonly lineageRecorded: false;
}

/**
 * Copy the cut into the child, and only then create the child's record.
 *
 * THE ORDER IS THE DURABILITY ARGUMENT. A crash between the two writes is the case this has to be
 * right for, and writing the spec first would leave a child that has a record and half a history —
 * which `driveRun` would happily take over, replaying a prefix that stops in the middle of the
 * parent's past and then performing effects from there. Written last, a crash leaves journal entries
 * under an id with no record: `driveRun` refuses a run it cannot read a record for, and `startRun`
 * refuses a run whose journal already has records. **Neither entry point will touch it**, which is
 * the failure a partial fork should have.
 *
 * The entries are rewritten onto the child's run id as they are copied. That is not bookkeeping: a
 * journal takes only its own run's entries, and the prefix is now the CHILD's history — the parent's
 * copy stays exactly where it was, because fork is not rollback.
 */
export async function commitFork(
  kv: KV,
  endpoint: string,
  plan: ForkPlan,
  store: JournalStore,
): Promise<ForkCommitResult> {
  if (!plan.admissible) throw new ForkNotAdmissible(plan);

  // THIS GUARD DOES NOT COVER A CRASHED FORK, and saying so is the point of the comment. The record
  // is written LAST precisely so a partial fork is un-drivable, which means that after a crash there
  // is no record here to find and this check passes. What refuses the retry is one layer out: a
  // caller gets a durable store by activating the child's journal, and an activation expecting a NEW
  // run refuses one whose journal already has records. Both halves have cells — including one that
  // shows a HAND-BUILT store letting the prefix land twice, because a fence in another component is
  // a claim this file cannot make on its own.
  const existing = await readRunRecord(kv, endpoint, plan.child);
  if (existing !== undefined) {
    throw new ForkNotAdmissible({
      ...plan,
      admissible: false,
      refusals: [
        {
          code: "L5017",
          why: `run ${plan.child} already has a record; a fork mints a new run, and copying a prefix into one that already exists would rewrite somebody's history`,
        },
      ],
    });
  }

  for (const entry of plan.cut) {
    await store.append({ ...entry, run: plan.child });
  }

  await createRunSpec(kv, endpoint, plan.child, { pins: plan.pins, createdAt: plan.at });

  return { child: plan.child, copied: plan.cut.length, lineageRecorded: false };
}

/** A fork the plan refused, offered for commit anyway. The plan carries the per-step reason. */
export class ForkNotAdmissible extends Error {
  constructor(readonly plan: ForkPlan) {
    super(
      `run ${plan.parent} cannot fork at ${plan.fromStep}: ` +
        plan.refusals.map((r) => `${r.code}${r.step !== undefined ? ` at ${r.step}` : ""}`).join(", ") +
        `. The plan carries the per-step reason; nothing was written.`,
    );
    this.name = "ForkNotAdmissible";
  }
}

/**
 * A scope wraps what its body threw, so the cut's stop can arrive inside a wrapper.
 *
 * Structural rather than by class: the interpreter's scope errors carry the original on `reason`,
 * and a fork that only recognised the bare form would report "never reached" for every cut inside a
 * `parallel` — a refusal that reads exactly like the caller naming an unreachable step.
 */
function unwrapCut(e: unknown): unknown {
  let cur = e;
  for (let i = 0; i < 8; i += 1) {
    const inner = (cur as { reason?: unknown })?.reason;
    if (inner === undefined || inner === cur) return cur;
    cur = inner;
  }
  return cur;
}
