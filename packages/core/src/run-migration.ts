/**
 * The MIGRATION record: a run's move onto edited source, and who authorised what it discarded.
 *
 * **Why it is its own kind rather than a field on the run.** A records-KV record has two halves and
 * a migration fits neither. The spec half is what a thing IS, decided once and never re-decided —
 * a run's pins. The status half is what it is DOING, last-value-wins, rewritten by the driver on
 * every state change. A migration is append-only HISTORY with an actor on it, and a run can be
 * migrated more than once: putting it in the status half would let the second migration erase the
 * first, and putting it in the spec half would collide with what the spec already says.
 *
 * **The id is derived from the report's own content.** A migration is decided by a dry walk that a
 * crash can force to be re-run, so the same decision must land on the same record instead of filing
 * a second one — and a counter would need somebody to allocate it, which is a second arbiter for a
 * fact the content already determines. Identical retry, identical id, create-only write: the same
 * shape as a notice, for the same reason.
 *
 * **Deciding and applying are separate, and the CAS is the arbiter of the second.** The spec is the
 * report — what the check found, immutable. The status is the COMMIT: which driver actually
 * advanced the run. Two drivers racing to apply one migration both find no status and both write;
 * the store decides and the loser gets a conflict rather than a second belief.
 */
import { createHash } from "node:crypto";
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertIdToken } from "./endpoint-subjects.js";
import {
  RECORD_KINDS,
  createRecordEntry,
  readRecord,
  recordSpecKey,
  recordStatusKey,
  assertStatusValue,
} from "./endpoint-records.js";
import { canonicalJson } from "./canonical.js";

/** One journal entry the new source no longer reaches, as the record keeps it. */
export interface MigrationOrphanValue {
  readonly step: string;
  readonly kind: string;
  readonly verdict: "ignored" | "kept" | "rejected";
  readonly code?: string;
}

export interface RunMigrationSpecValue {
  readonly v: 1;
  readonly run: string;
  /**
   * The program hash the run was on, as the CALLER states it.
   *
   * Optional, and the reason is a gap rather than a preference: §17 delta 2 declares a program hash
   * on the run record and `RunSpecValue` deliberately never invented one, so nothing here can VERIFY
   * this. Recorded as the caller's claim when supplied and absent when not — an unverifiable field
   * labelled as such beats one this file computes from a source it was never given.
   */
  readonly fromHash?: string;
  /** The hash of the source the run is moving TO. Computed from that source, so not a claim. */
  readonly toHash: string;
  readonly at: number;
  /** How many recorded entries the walk accounted for. */
  readonly consumedThrough: number;
  readonly orphans: readonly MigrationOrphanValue[];
  /** What the caller overrode, verbatim, because an override is a person's decision. */
  readonly overrides: readonly string[];
  readonly actor: string;
}

export interface RunMigrationStatusValue {
  readonly v: 1;
  /** When the run actually advanced. */
  readonly appliedAt: number;
  /** WHICH driver advanced it, so an application can be traced to the holder that made it. */
  readonly by: string;
  readonly observedSpecRevision: number;
}

const SPEC_KEYS = ["v", "run", "fromHash", "toHash", "at", "consumedThrough", "orphans", "overrides", "actor"];
const STATUS_KEYS = ["v", "appliedAt", "by", "observedSpecRevision"];

function qualifiers(endpoint: string, runId: string, migrationId: string): string[] {
  return [endpoint, runId, migrationId];
}

/** base64url of the sha256, truncated to 43 — an `<id-token>` by construction, as elsewhere. */
function digestId(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 43);
}

/**
 * The id one migration is filed under: a digest of the report itself.
 *
 * Everything the decision consists of goes in, so a re-run of the same check over the same journal
 * re-derives the same id and its create-only write lands on its own record. Change what was found
 * or what was overridden and it is a different migration, which is exactly right — it is.
 */
export function runMigrationId(value: Omit<RunMigrationSpecValue, "at">): string {
  return digestId(canonicalJson(value));
}

function parseSpec(raw: unknown, key: string): RunMigrationSpecValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `migration ${key} is not an object; garbled state never authorizes`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!SPEC_KEYS.includes(k))
      throw new EpEnvelopeError("internal", `migration ${key} carries the unknown field "${k}"; record schemas are closed`);
  if (
    o.v !== 1 || typeof o.run !== "string" || typeof o.toHash !== "string" || o.toHash.length === 0
    || typeof o.actor !== "string" || o.actor.length === 0
    || typeof o.at !== "number" || !Number.isSafeInteger(o.at) || o.at < 0
    || typeof o.consumedThrough !== "number" || !Number.isSafeInteger(o.consumedThrough) || o.consumedThrough < 0
    || !Array.isArray(o.orphans) || !Array.isArray(o.overrides)
    || (o.fromHash !== undefined && typeof o.fromHash !== "string")
  ) {
    throw new EpEnvelopeError("internal", `migration ${key} is malformed; garbled state never authorizes`);
  }
  return {
    v: 1,
    run: o.run,
    ...(o.fromHash !== undefined ? { fromHash: o.fromHash as string } : {}),
    toHash: o.toHash,
    at: o.at,
    consumedThrough: o.consumedThrough,
    orphans: o.orphans as readonly MigrationOrphanValue[],
    overrides: o.overrides as readonly string[],
    actor: o.actor,
  };
}

function parseStatus(raw: unknown, key: string): RunMigrationStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `migration status ${key} is not an object; garbled state never authorizes`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!STATUS_KEYS.includes(k))
      throw new EpEnvelopeError("internal", `migration status ${key} carries the unknown field "${k}"; record schemas are closed`);
  if (o.v !== 1 || typeof o.appliedAt !== "number" || !Number.isSafeInteger(o.appliedAt) || o.appliedAt < 0
    || typeof o.by !== "string" || o.by.length === 0)
    throw new EpEnvelopeError("internal", `migration status ${key} is malformed; garbled state never authorizes`);
  return {
    v: 1,
    appliedAt: o.appliedAt,
    by: o.by,
    observedSpecRevision: o.observedSpecRevision as number,
  };
}

/**
 * File one migration's report, create-only.
 *
 * An identical retry is this attempt's own earlier write and is not a conflict. Differing content
 * under one id would mean two decisions claiming one identity, which is refused rather than
 * overwritten: a migration that could be rewritten would be a draft, and what it records is what a
 * person authorised to discard.
 */
export async function writeRunMigration(
  kv: KV,
  endpoint: string,
  migrationId: string,
  value: RunMigrationSpecValue,
): Promise<{ key: string; created: boolean }> {
  assertIdToken(migrationId, "migrationId");
  const key = recordSpecKey(RECORD_KINDS.migration, qualifiers(endpoint, value.run, migrationId));
  try {
    await createRecordEntry(kv, key, value);
    return { key, created: true };
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await kv.get(key);
    if (!existing || existing.operation !== "PUT")
      throw new EpEnvelopeError("internal", `migration ${key} lost its create CAS but is not readable; reconcile the store`);
    const parsed = parseSpec(JSON.parse(new TextDecoder().decode(existing.value)), key);
    if (canonicalJson(parsed) !== canonicalJson(value))
      throw new EpEnvelopeError("conflict", `migration ${key} already exists with a different report; a migration id is derived from what the check found, so a differing one under the same id is never overwritten`);
    return { key, created: false };
  }
}

export interface RunMigrationRead {
  readonly migrationId: string;
  readonly spec: RunMigrationSpecValue;
  readonly specRevision: number;
  readonly applied?: RunMigrationStatusValue;
}

/** Read one migration with its application, or `undefined` when nothing was filed under this id. */
export async function readRunMigration(
  kv: KV,
  endpoint: string,
  runId: string,
  migrationId: string,
): Promise<RunMigrationRead | undefined> {
  const q = qualifiers(endpoint, runId, migrationId);
  const merged = await readRecord(kv, RECORD_KINDS.migration, q);
  if (merged === undefined) return undefined;
  const spec = parseSpec(merged.spec.value, recordSpecKey(RECORD_KINDS.migration, q));
  const status = merged.status === undefined
    ? undefined
    : parseStatus(merged.status.value, recordStatusKey(RECORD_KINDS.migration, q));
  return {
    migrationId,
    spec,
    specRevision: merged.spec.revision,
    ...(status !== undefined ? { applied: status } : {}),
  };
}

/**
 * Every migration filed on one run, oldest first.
 *
 * ORDER IS THE POINT of an append-only history: a run's second migration is only interpretable
 * beside its first. `at` decides, then the id, so two filed in the same millisecond still come back
 * in one fixed order rather than in whatever order the store enumerated its keys.
 */
export async function listRunMigrations(
  kv: KV,
  endpoint: string,
  runId: string,
): Promise<RunMigrationRead[]> {
  const prefix = recordSpecKey(RECORD_KINDS.migration, qualifiers(endpoint, runId, "m")).slice(0, -"m.spec".length);
  // ONE wildcard token: only the migration id varies under this prefix, and a KV filter's `*`
  // matches exactly one token — one too few matches a key shape that does not exist and silently
  // returns nothing.
  const seen = await kv.keys(`${prefix}*.spec`);
  const ids: string[] = [];
  for await (const key of seen) {
    const parts = key.split(".");
    ids.push(parts[parts.length - 2] as string);
  }
  const found: RunMigrationRead[] = [];
  for (const id of ids) {
    const one = await readRunMigration(kv, endpoint, runId, id);
    if (one !== undefined) found.push(one);
  }
  found.sort((a, b) => (a.spec.at - b.spec.at) || (a.migrationId < b.migrationId ? -1 : a.migrationId > b.migrationId ? 1 : 0));
  return found;
}

/**
 * Record that a driver applied this migration.
 *
 * **The create-only CAS is the arbiter and it is the only one.** Two drivers racing to apply one
 * migration both read no status and both write; the store decides, and the loser gets a loud
 * conflict rather than a second belief about a run that moved once. A "has it been applied?" read
 * before the write would be a fast path that lies under exactly the race it looks like it prevents.
 */
export async function markRunMigrationApplied(
  kv: KV,
  endpoint: string,
  runId: string,
  migrationId: string,
  by: string,
  at: number,
): Promise<void> {
  const q = qualifiers(endpoint, runId, migrationId);
  const specKey = recordSpecKey(RECORD_KINDS.migration, q);
  const statusKey = recordStatusKey(RECORD_KINDS.migration, q);
  const merged = await readRecord(kv, RECORD_KINDS.migration, q);
  if (merged === undefined)
    throw new EpEnvelopeError("failed-precondition", `no migration is filed at ${specKey}; an application names the migration it applied`);
  const value = assertStatusValue({
    v: 1 as const,
    appliedAt: at,
    by,
    observedSpecRevision: merged.spec.revision,
  });
  try {
    await createRecordEntry(kv, statusKey, value);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    // The CAS lost, and only NOW is anything read — the same shape as the notice writer, and for
    // the same reason: a "has it been applied?" check before the write would be a fast path that
    // lies under exactly the race it looks like it prevents. What the read decides is who lost. A
    // driver that finds its OWN application is looking at its own earlier attempt, which is the
    // retry a crash between the two writes forces, and that is not a conflict. A different driver
    // is the real race, and it hears about it.
    const existing = await readRecord(kv, RECORD_KINDS.migration, q);
    const already = existing?.status === undefined ? undefined : parseStatus(existing.status.value, statusKey);
    if (already?.by === by) return;
    throw new EpEnvelopeError(
      "conflict",
      `migration ${specKey} was already applied by ${already?.by ?? "another driver"}; a run moves once, and the store decides which driver moved it`,
    );
  }
}
