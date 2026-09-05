/**
 * Migrate a run onto edited source: the migrate check, and why the check is the whole decision.
 *
 * Nothing here rewrites a journal and nothing here performs an effect. A migration is decided by a
 * DRY walk of the new program over the recorded journal, and the walk answers two questions with
 * two different inputs — which is the distinction that decided it. Whether a RECORD is still valid
 * is a question about the record and is answered on the raw fact; which records the program still
 * REACHES is a question about the program and is answered through its own view, with checkpoint
 * policy applied. Both live in the language: the hash comparison in `Journal.lookup`, the policy
 * sandwich at the interpreter's `checkpoint` call site. This file supplies the walk's mode, reads
 * what it left behind, and applies the orphan table.
 *
 * **The orphan table is by effect kind because our removed steps have consequences.** "Removed
 * steps' data is ignored" is right for a step that outlives nothing. It is wrong for an agent that
 * is still running, a conclave whose membership is still open, a decision a person actually made,
 * and a notice an agent has not yet been told. Each of those is a REFUSAL with a code, and the
 * refusal is the product: a migration that quietly dropped one would be an evidence-carrying system
 * discarding evidence.
 *
 * **The commit files its own record kind, and that was a scope decision rather than a preference.**
 * The obvious home for a `migrated` fact is the run record itself; a records-KV record has a
 * create-only half for what a thing IS and a last-value-wins half for what it is DOING, and a
 * migration is neither — it is append-only history with an actor, and a run can migrate more than
 * once. So there is a `migration` kind (SPEC amendment A10), keyed by a content-derived id, whose
 * spec is the report and whose status is the application.
 *
 * **What the commit still does NOT do**: advance the run's pinned program hash, because
 * `RunSpecValue` carries none to advance — a program-hash pin is declared and unbuilt, and this
 * branch deliberately did not invent it. The migration is durable and readable; the run record does
 * not yet name its source.
 */
import type { KV } from "@nats-io/kv";
import {
  listRunNoticesForRun,
  runMigrationId,
  writeRunMigration,
  markRunMigrationApplied,
  type RunMigrationSpecValue,
} from "@cotal-ai/core";
import {
  Journal,
  JournalReadOnlyError,
  journalEntryKeyString,
  programHashOf,
  run as runProgram,
  RunDivergence,
  UnwalkableScope,
  ScopeBranchMissing,
  type EffectContext,
  type EffectHandler,
  type JournalEntry,
  type RunPins,
} from "@cotal-ai/lang";

/** What the caller decided to override, and therefore what the record has to say they decided. */
export interface MigrateOverrides {
  /**
   * Discard human decisions the edit made unreachable. Recorded WITH the actor: the one
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
 * `admissible` is the commit condition — no divergence and the orphan table satisfied — and
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
  /** The hash of the source this run would move TO. Computed from that source, so not a claim. */
  readonly toHash: string;
  readonly fromHash?: string;
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
  /**
   * The program hash the run was on, as the CALLER states it.
   *
   * Not verifiable here and deliberately not invented: a program-hash pin on the run record is
   * declared and unbuilt, and `RunSpecValue` does not carry one yet, so a hash computed from a
   * source this function was never given would be a guess wearing a fact's name. Absent when the
   * caller does not know it, and the record says absent rather than approximate.
   */
  readonly fromHash?: string;
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
 * The migrate walk "stops at the frontier", and the frontier is exactly the first effect with no
 * record behind it. A handler that returned a plausible value instead would carry the walk past it
 * into a region where every subsequent step is a `miss`, and the orphan set — the entire output —
 * would be computed against a history the run does not have.
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
 * Run the migrate check. Reads; never writes.
 *
 * The report is the product whether or not the migration is admissible — a rejected migration owes
 * the caller the per-step reason, which is the only thing that makes repair possible (the `L`
 * catalogue).
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
    } else if (e instanceof UnwalkableScope || e instanceof ScopeBranchMissing) {
      // Both are "the walk could not enter this scope", which is what `unwalkable` is for and what
      // blocks `admissible` below. They are separate classes because the REPAIRS differ — a
      // conclave needs a fork, a missing branch needs the arm's name back — and `why` carries the
      // whole refusal, which for L5022 names the recorded arms, the source's arms, and the gap.
      unwalkable = { step: e.scopeKey, why: e.message };
    } else if (!(e instanceof Frontier) && !(e instanceof JournalReadOnlyError)) {
      // A program fault under an edited source is the migration's answer too — L4007 from an edited
      // `onExpiry: fail` is exactly the case the walk is specified to handle — but it is not a
      // divergence, and it is not this function's to swallow. The steps after it were simply not
      // reached, which is already visible in the orphan set below.
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
    toHash: programHashOf(req.source),
    ...(req.fromHash !== undefined ? { fromHash: req.fromHash } : {}),
    admissible,
    // BOTH COUNTS FROM THE SAME VIEW. `req.entries` is the raw replayed APPEND LOG, where a
    // completed step appears at least twice (a pending row, then its settle), while `orphans()`
    // reads the folded, keyed view. Subtracting one from the other counted something that is
    // neither, and it lands in a durable migration record AND in that record's content-derived
    // id, so the same decision computed from a differently-shaped replay filed under a different
    // migration.
    consumedThrough: journal.entries().length - orphans.length,
    orphans: table,
    ...(divergence !== undefined ? { divergence } : {}),
    ...(unwalkable !== undefined ? { unwalkable } : {}),
    overrides,
  };
}

/**
 * File the migration, and record that this driver applied it.
 *
 * TWO WRITES AND THEY ARE DIFFERENT ACTS. The report is filed create-only under an id derived from
 * its own content, so the retry a crash forces lands on its own record rather than filing a second
 * migration for one decision. The application is a separate, create-only status: two drivers racing
 * to advance one run both find no status and both write, and the store decides. A driver that lost
 * that race hears about it instead of believing it moved a run somebody else moved.
 *
 * REFUSED FOR AN INADMISSIBLE REPORT, before anything is written. A migration the check rejected is
 * not a migration with a caveat — filing it would put a decision nobody may act on into the same
 * history a reader trusts, and the refusal is the product the check exists to produce.
 *
 * A `--release` override is HONOURED HERE: the named seats are despawned through the run's own
 * discharge before the migration is filed, so the record never claims a release nothing performed.
 * An `--adopt` override is honoured by the driver that next runs the program: the migration's kept
 * spawn rows are what its handler hands to the next spawn of that persona ({@link migrationSeats}).
 *
 * What is still NOT here, stated rather than implied: the run's pinned program hash does not
 * advance, because `RunSpecValue` carries no program hash to advance — that pin is declared and
 * unbuilt, and this branch does not invent it. The migration is durable and readable; the run
 * record does not yet name which source it is on.
 */
export async function commitMigration(
  kv: KV,
  endpoint: string,
  report: MigrateReport,
  driver: string,
  seats?: { entries: readonly JournalEntry[]; handler: { discharge(entries: readonly JournalEntry[]): Promise<unknown> } },
): Promise<{ migrationId: string; created: boolean; released: readonly string[] }> {
  if (!report.admissible) {
    throw new MigrationNotAdmissible(report);
  }
  // `--release` is an act, not a note: the seats it names are torn down through the run's own
  // discharge, the same path a cancelled branch's seat leaves by, BEFORE the migration is filed as
  // applied. A commit that filed the release and despawned nothing would be the fake success this
  // row existed to refuse. A report that releases a seat needs the journal and a discharger to
  // release it with; a caller that has neither is refused rather than recorded as having done it.
  const release = seats === undefined ? [] : migrationSeats(seats.entries, report).release;
  if (seats === undefined && report.overrides.some((o) => o.startsWith("--release ")))
    throw new Error(`migration of run ${report.run} releases a seat, and a commit with no journal and no discharger cannot tear one down; nothing was written`);
  if (release.length > 0) await seats!.handler.discharge(release);
  const content: Omit<RunMigrationSpecValue, "at"> = {
    v: 1,
    run: report.run,
    ...(report.fromHash !== undefined ? { fromHash: report.fromHash } : {}),
    toHash: report.toHash,
    consumedThrough: report.consumedThrough,
    orphans: report.orphans.map((o) => ({
      step: o.step,
      kind: o.kind,
      verdict: o.verdict,
      ...(o.code !== undefined ? { code: o.code } : {}),
    })),
    overrides: report.overrides,
    actor: report.actor,
  };
  const migrationId = runMigrationId(content);
  const { created } = await writeRunMigration(kv, endpoint, migrationId, { ...content, at: report.at });
  await markRunMigrationApplied(kv, endpoint, report.run, migrationId, driver, report.at);
  return { migrationId, created, released: release.map((e) => spawnedHandle(e) as string) };
}

/** A migration the check refused, offered for commit anyway. The report says which rows refused. */
export class MigrationNotAdmissible extends Error {
  constructor(readonly report: MigrateReport) {
    const refused = report.orphans.filter((o) => o.verdict === "rejected");
    super(
      `run ${report.run} cannot migrate: ` +
        (report.divergence !== undefined
          ? `${report.divergence.step} diverged`
          : report.unwalkable !== undefined
            ? `the walk could not enter ${report.unwalkable.step}`
            : refused.map((o) => `${o.code} at ${o.step}`).join(", ")) +
        `. The report carries the per-step reason; nothing was written.`,
    );
    this.name = "MigrationNotAdmissible";
  }
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

/** The agent a settled `spawn` entry produced (`<name>#<lifecycleUid>`), or nothing: a spawn that
 *  failed, was cancelled, or never settled left no seat the program can name. A cancelled spawn's
 *  seat is the cancellation discharge's to release, not a migration's. */
function spawnedHandle(e: JournalEntry): string | undefined {
  if (e.kind !== "spawn" || e.state !== "settled" || e.status !== "ok") return undefined;
  const agent = (e.result as { agent?: unknown } | undefined)?.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}

function spawnedPersona(e: JournalEntry): string {
  const persona = (e.result as { persona?: unknown } | undefined)?.persona;
  return typeof persona === "string" ? persona : e.name;
}

/**
 * The seats a committed migration hands over or tears down, read off the report's own rows so the
 * commit acts on exactly what the report said. `release` is every settled spawn the caller named
 * with `--release`; `adopt` maps each persona to the handle its next spawn receives, in journal
 * order, so two adopted seats of one persona are handed out in the order they were spawned.
 */
export function migrationSeats(
  entries: readonly JournalEntry[],
  report: { readonly orphans: readonly { readonly step: string; readonly verdict: string }[]; readonly overrides: readonly string[] },
): { release: readonly JournalEntry[]; adopt: ReadonlyMap<string, readonly JournalEntry[]> } {
  const rows = new Map(report.orphans.map((o) => [o.step, o] as const));
  // A seat already handed over is spent: the spawn that received it bound `adoptedFrom` naming the
  // orphaned step, so a later resume of the migrated run hands it out to nobody else.
  const spent = new Set(entries.map((e) => (e.external as { adoptedFrom?: unknown } | undefined)?.adoptedFrom).filter((k): k is string => typeof k === "string"));
  const release: JournalEntry[] = [];
  const adopt = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const handle = spawnedHandle(e);
    if (handle === undefined) continue;
    const key = journalEntryKeyString(e);
    if (spent.has(key)) continue;
    const row = rows.get(key);
    if (row === undefined) continue;
    if (report.overrides.includes(`--release ${handle}`) && row.verdict === "ignored") release.push(e);
    if (report.overrides.includes(`--adopt ${handle}`) && row.verdict === "kept") {
      const persona = spawnedPersona(e);
      adopt.set(persona, [...(adopt.get(persona) ?? []), e]);
    }
  }
  return { release, adopt };
}

/**
 * The orphan table, one entry at a time.
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
          "L5013",
          "no notice is filed for this step, so whether it was delivered cannot be established; a migration does not guess about a decision already sent",
        );
      return reject(
        "L5013",
        "the notice has not been carried by its addressee's next turn, and migrating would deliver a decision the new program no longer makes",
      );
    }

    case "conclave":
      return e.closed === true
        ? ignore("the scope closed, so no membership outlives it")
        : reject("L5014", "an open conclave is live membership the new program cannot close");

    case "spawn": {
      // The repair the spec names is `--adopt <handle>` or `--release <handle>`, each naming the
      // agent the orphaned step spawned. A step that never produced a handle spawned nothing the
      // new program could leak, so it is ignored like a sleep; a settled one is a live seat.
      const handle = spawnedHandle(e);
      if (handle === undefined) return ignore("the spawn never produced an agent, so no seat outlives it");
      const adopt = o?.adopt?.includes(handle) === true;
      const release = o?.release?.includes(handle) === true;
      if (adopt && release)
        return reject("L5003", `${handle} is named by both --adopt and --release; one agent is reassigned or torn down, never both`);
      if (adopt)
        return {
          step, kind: e.kind, verdict: "kept",
          why: `${handle} is adopted under --adopt: the new program's next spawn of persona "${spawnedPersona(e)}" receives this seat instead of minting one, and the override is recorded with the actor who passed it`,
        };
      if (release)
        return {
          step, kind: e.kind, verdict: "ignored",
          why: `${handle} is torn down under --release when the migration commits, and the override is recorded with the actor who passed it`,
        };
      return reject(
        "L5003",
        `the edit dropped a step that spawned ${handle}, a live agent; pass --adopt ${handle} to hand it to the new program's next spawn of that persona, or --release ${handle} to tear it down`,
      );
    }

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
      // A scope is not an effect and outlives nothing by itself; every consequence it had belongs
      // to an entry underneath it, and those get their own rows. `conclave` is the exception and is
      // above, which is exactly why the orphan table lists it and not these three.
      return ignore("a scope outlives nothing of its own; what ran under it has its own rows");

    default:
      // Anything a later version journals. A kind this table does not know is not a kind it may wave
      // through: the table is the safety property, and an unlisted kind means it has a hole.
      return reject(
        "L5015",
        `no orphan policy is defined for a ${e.kind} entry, and a migration does not invent one`,
      );
  }
}
