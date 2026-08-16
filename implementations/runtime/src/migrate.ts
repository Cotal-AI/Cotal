/**
 * Migrate a run onto edited source: the §8.4 check, and why the check is the whole decision.
 *
 * Nothing here rewrites a journal and nothing here performs an effect. A migration is decided by a
 * DRY walk of the new program over the recorded journal, and the walk answers two questions with two
 * different inputs — which is the distinction the design spent a section on. Whether a RECORD is
 * still valid is a question about the record and is answered on the raw fact; which records the
 * program still REACHES is a question about the program and is answered through its own view, with
 * checkpoint policy applied. Both live in the language: the hash comparison in `Journal.lookup`, the
 * policy sandwich at the interpreter's `checkpoint` call site. This file supplies the walk's mode,
 * reads what it left behind, and applies the orphan table.
 *
 * **The orphan table is by effect kind because our removed steps have consequences.** "Removed
 * steps' data is ignored" is right for a step that outlives nothing. It is wrong for an agent that
 * is still running, a conclave whose membership is still open, a decision a person actually made,
 * and a notice an agent has not yet been told. Each of those is a REFUSAL with a code, and the
 * refusal is the product: a migration that quietly dropped one would be an evidence-carrying system
 * discarding evidence.
 *
 * **The commit is a named seam and does not exist here.** §8.4 files a `migrated` fact onto the run
 * record and advances the run's pinned program hash. This tree's run record has neither a home for
 * append-only history — its two halves are "decided once" (create-only) and "current state"
 * (last-value-wins, rewritten by every driver heartbeat) — nor the program hash §17 delta 2 declares
 * but slice (b) deliberately did not invent. So {@link commitMigration} refuses by name rather than
 * writing the fact somewhere it would be clobbered or misread. The check above it is complete.
 */
import type { KV } from "@nats-io/kv";
import { listRunNoticesForRun } from "@cotal-ai/core";
import {
  Journal,
  JournalReadOnlyError,
  journalEntryKeyString,
  run as runProgram,
  RunDivergence,
  UnwalkableScope,
  type EffectContext,
  type EffectHandler,
  type JournalEntry,
  type RunPins,
} from "@cotal-ai/lang";
import { NotYetDurable } from "./mesh-handler.js";

/** What the caller decided to override, and therefore what the record has to say they decided. */
export interface MigrateOverrides {
  /**
   * Discard human decisions the edit made unreachable. Recorded WITH the actor: §8.4's one
   * absolute is that a recorded human decision is never discarded quietly.
   */
  readonly discardApprovals?: boolean;
  /** `--adopt <handle>` / `--release` for an orphaned spawn. Lane-A-gated by their subject. */
  readonly adopt?: readonly string[];
  readonly release?: readonly string[];
}

export type OrphanVerdict = "ignored" | "kept" | "rejected";

/** One journal entry the new source no longer reaches, and what the table says about it. */
export interface MigrateOrphan {
  readonly step: string;
  readonly kind: string;
  readonly verdict: OrphanVerdict;
  /** The error catalog code, on a rejection only. */
  readonly code?: string;
  readonly why: string;
}

export interface MigrateDivergence {
  readonly step: string;
  readonly recordedHash: string;
  readonly programHash: string;
}

/**
 * The answer a migration attempt produces.
 *
 * `admissible` is the §8.4 commit condition — no divergence and the orphan table satisfied — and
 * NOT a statement that anything was written. Nothing is: see {@link commitMigration}.
 */
export interface MigrateReport {
  readonly run: string;
  readonly at: number;
  readonly actor: string;
  readonly admissible: boolean;
  /** How many recorded entries the walk accounted for. */
  readonly consumedThrough: number;
  readonly orphans: readonly MigrateOrphan[];
  readonly divergence?: MigrateDivergence;
  /** A scope the walk could not enter, which is a refusal rather than a silent consume. */
  readonly unwalkable?: { readonly step: string; readonly why: string };
  /** The overrides the caller passed, as recorded strings, for the fact the commit will file. */
  readonly overrides: readonly string[];
}

export interface MigrateRequest {
  /** The endpoint hosting the driver — the notices are keyed under it. */
  readonly endpoint: string;
  readonly runId: string;
  /** The NEW program. */
  readonly source: string;
  /** The recorded journal, as the barrier replayed it. */
  readonly entries: readonly JournalEntry[];
  /** Read back from the run record, never re-derived: a migration does not re-pin a run. */
  readonly pins: RunPins;
  readonly kv: KV;
  /** Who asked. Recorded on any override, because an override is a person's decision. */
  readonly actor: string;
  readonly now: () => number;
  readonly overrides?: MigrateOverrides;
  readonly file?: string;
}

/** The walk reached work the recorded run never did. Not an error: it is where a walk STOPS. */
class Frontier extends Error {
  constructor(readonly step: string) {
    super(`the dry walk reached the frontier at ${step}`);
    this.name = "Frontier";
  }
}

/**
 * A handler that performs NOTHING and says so by stopping.
 *
 * §8.4's walk "stops at the frontier", and the frontier is exactly the first effect with no record
 * behind it. A handler that returned a plausible value instead would carry the walk past it into a
 * region where every subsequent step is a `miss`, and the orphan set — the entire output — would be
 * computed against a history the run does not have.
 *
 * IT IS THE SECOND STOP, NOT THE FIRST, and that is worth knowing rather than discovering. The walk
 * reads a READ-ONLY journal, so a missing step is refused at `begin` before any handler is reached:
 * the check's inability to write is what actually terminates it. This handler catches the case the
 * journal cannot — an entry left PENDING by a crash, which is looked up rather than begun — and is
 * the belt for any later path that reaches a handler without appending first.
 */
function dryHandler(now: () => number): EffectHandler {
  const stop = (_req: unknown, ctx: EffectContext): never => {
    throw new Frontier(`${ctx.key.kind}:${ctx.key.name}#${ctx.key.occurrence}`);
  };
  return {
    now,
    spawn: stop, turn: stop, ask: stop, checkpoint: stop, sleep: stop,
    wait: stop, notify: stop, monitor: stop, openConclave: stop, closeConclave: stop,
  } as unknown as EffectHandler;
}

/**
 * Run §8.4's check. Reads; never writes.
 *
 * The report is the product whether or not the migration is admissible — a rejected migration owes
 * the caller the per-step reason, which is the only thing that makes repair possible (§11).
 */
export async function migrateRun(req: MigrateRequest): Promise<MigrateReport> {
  const journal = new Journal({ run: req.runId, entries: req.entries, readOnly: true });

  let divergence: MigrateDivergence | undefined;
  let unwalkable: { step: string; why: string } | undefined;
  try {
    await runProgram(req.source, {
      runId: req.runId,
      handler: dryHandler(req.now),
      journal,
      migration: true,
      pins: req.pins,
      ...(req.file !== undefined ? { file: req.file } : {}),
    });
  } catch (e) {
    if (e instanceof RunDivergence) {
      divergence = {
        step: e.stepKey,
        recordedHash: e.recordedHash,
        programHash: e.programHash,
      };
    } else if (e instanceof UnwalkableScope) {
      unwalkable = { step: e.scopeKey, why: e.message };
    } else if (!(e instanceof Frontier) && !(e instanceof JournalReadOnlyError)) {
      // A program fault under an edited source is the migration's answer too — L4007 from an edited
      // `onExpiry: fail` is exactly the case §8.4 walks through — but it is not a divergence, and
      // it is not this function's to swallow. The steps after it were simply not reached, which is
      // already visible in the orphan set below.
      if (!isProgramFault(e)) throw e;
    }
  }

  const orphans = journal.orphans();
  const notices = orphans.some((o) => o.kind === "notify")
    ? await listRunNoticesForRun(req.kv, req.endpoint, req.runId)
    : [];
  const consumedBy = new Map<string, boolean>();
  for (const n of notices) {
    const key = n.spec.step;
    consumedBy.set(key, (consumedBy.get(key) ?? true) && n.consumed !== undefined);
  }

  const overrides = recordedOverrides(req.overrides);
  const table = orphans.map((e) => classify(e, req.overrides, consumedBy));

  const admissible =
    divergence === undefined &&
    unwalkable === undefined &&
    !table.some((o) => o.verdict === "rejected");

  return {
    run: req.runId,
    at: req.now(),
    actor: req.actor,
    admissible,
    consumedThrough: req.entries.length - orphans.length,
    orphans: table,
    ...(divergence !== undefined ? { divergence } : {}),
    ...(unwalkable !== undefined ? { unwalkable } : {}),
    overrides,
  };
}

/**
 * File the migration and advance the run's pinned hash.
 *
 * REFUSED, by name, and the reason is structural rather than unfinished wiring. §8.4's `migrated`
 * fact is append-only history with an actor on it; a records-KV record has a create-only half for
 * what a thing IS and a last-value-wins half for what it is DOING, and the driver rewrites the
 * second one on every state change. Filing the fact there means either a read-modify-write race
 * against the driver's own heartbeat or a second writer for one value. And "the run's pinned hash
 * advances" needs a pinned hash: §17 delta 2 declares one, `RunSpecValue` deliberately does not
 * carry it, and inventing it here would be a different function's answer wearing that name.
 *
 * The check above is complete and its report is the whole decision. What is missing is a home for
 * the decision, which is a record-shape question and belongs where record shapes are decided.
 */
export async function commitMigration(_report: MigrateReport): Promise<never> {
  throw new NotYetDurable(
    "migrate/commit",
    "a durable home for an append-only `migrated` fact and the run record's pinned program hash (§17 delta 2)",
  );
}

/** A fault the PROGRAM raised under the new source. Named by code, not by class: the language's
 *  faults cross the package boundary as values and a structural check is what survives that. */
function isProgramFault(e: unknown): boolean {
  return typeof (e as { code?: unknown })?.code === "string";
}

function recordedOverrides(o: MigrateOverrides | undefined): string[] {
  if (o === undefined) return [];
  const out: string[] = [];
  if (o.discardApprovals === true) out.push("--discard-approvals");
  for (const h of o.adopt ?? []) out.push(`--adopt ${h}`);
  for (const h of o.release ?? []) out.push(`--release ${h}`);
  return out;
}

/**
 * §8.4's orphan table, one entry at a time.
 *
 * `kept` rather than `ignored` for a turn, because the two are different promises. An ignored sleep
 * leaves nothing behind. An ignored TURN would be a claim that an agent did not speak, and it did:
 * the entry stays in the journal and the migration says so, so no reader is ever told the work did
 * not happen.
 */
function classify(
  e: JournalEntry,
  o: MigrateOverrides | undefined,
  noticeConsumed: ReadonlyMap<string, boolean>,
): MigrateOrphan {
  const step = journalEntryKeyString(e);
  const ignore = (why: string): MigrateOrphan => ({ step, kind: e.kind, verdict: "ignored", why });
  const reject = (code: string, why: string): MigrateOrphan =>
    ({ step, kind: e.kind, verdict: "rejected", code, why });

  switch (e.kind) {
    case "sleep":
    case "wait":
    case "monitor":
    case "ask":
      return ignore("nothing outlives it");

    case "turn":
      return {
        step,
        kind: e.kind,
        verdict: "kept",
        why: "the agent already took this turn and spoke in its channels; the entry stays and the migration records that the current source no longer accounts for it",
      };

    case "notify": {
      const consumed = noticeConsumed.get(step);
      if (consumed === true) return ignore("its notice was already carried by the addressee's next turn");
      if (consumed === undefined)
        return reject(
          "L5005",
          "no notice is filed for this step, so whether it was delivered cannot be established; a migration does not guess about a decision already sent",
        );
      return reject(
        "L5005",
        "the notice has not been carried by its addressee's next turn, and migrating would deliver a decision the new program no longer makes",
      );
    }

    case "conclave":
      return e.closed === true
        ? ignore("the scope closed, so no membership outlives it")
        : reject("L5006", "an open conclave is live membership the new program cannot close");

    case "spawn":
      // §8.4 clears this row with `--adopt <handle>` or `--release`. NEITHER IS HONOURED HERE, and
      // that is the seam rather than an omission: both name a durable agent this host cannot
      // address, because `spawn` itself rides Lane A's durable-action machinery. An override that
      // read as accepted would be the fake success — a migration recorded as having released an
      // agent nothing ever released.
      return (o?.adopt?.length ?? 0) + (o?.release?.length ?? 0) > 0
        ? reject(
            "L5003",
            "--adopt and --release name a durable agent handle, and spawn is not durable on this host yet: it rides the durable-action machinery, which has not landed. The override is refused rather than recorded as honoured.",
          )
        : reject(
            "L5003",
            "the edit dropped a step that spawned a live agent; pass --adopt <handle> to reassign it or --release to tear it down",
          );

    case "checkpoint": {
      const raw = e.result as { outcome?: string; by?: string } | undefined;
      if (raw?.outcome !== "resolved") return ignore("no human decision was recorded against it");
      if (o?.discardApprovals === true)
        return {
          step,
          kind: e.kind,
          verdict: "kept",
          why: `a recorded decision${raw.by !== undefined ? ` by ${raw.by}` : ""} is discarded under --discard-approvals, and the override is recorded with the actor who passed it`,
        };
      return reject(
        "L5004",
        `the edit would discard a decision${raw.by !== undefined ? ` ${raw.by} actually made` : " a person actually made"}; pass --discard-approvals if that is intended`,
      );
    }

    case "parallel":
    case "race":
    case "fanOut":
      // A scope is not an effect and outlives nothing by itself; every consequence it had belongs to
      // an entry underneath it, and those get their own rows. `conclave` is the exception and is
      // above, which is exactly why §8.4's table lists it and not these three.
      return ignore("a scope outlives nothing of its own; what ran under it has its own rows");

    default:
      // Anything a later version journals. A kind this table does not know is not a kind it may wave
      // through: the table is the safety property, and an unlisted kind means it has a hole.
      return reject(
        "L5007",
        `no orphan policy is defined for a ${e.kind} entry, and a migration does not invent one`,
      );
  }
}
