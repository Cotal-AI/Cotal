import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KV } from "@nats-io/kv";
import {
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertPrincipalOwnerToken,
  assertValidOwnerToken,
  isCasLoss,
  staticSlotKey,
  type RuntimeReference,
} from "@cotal-ai/core";
import { spaceKey } from "@cotal-ai/workspace";
import {
  captureProcessIdentity,
  probeRecordedProcess,
  type ProcessProbeVerdict,
  type RecordedProcessIdentity,
} from "@cotal-ai/seat";

export { captureProcessIdentity, probeRecordedProcess, type ProcessProbeVerdict };
export type ManagerSlotProcess = RecordedProcessIdentity;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const USER_SLOT_INDEX_TOKEN = "_index";

export interface ManagerSlotEnrollSpec {
  role?: string;
  label: string;
  capabilities?: string[];
  subscribe?: string[];
  allowSubscribe: string[];
  allowPublish?: string[];
}

export type ManagerSlotPhase =
  | "enrolling"
  | "provisioning"
  | "active"
  | "preserved"
  | "releasing"
  | "retired";

export interface ManagerSlotRecord {
  v: 1;
  space: string;
  /** The manager holder's own principal owner (`u_…` or `p_…`). Must equal the KV key's second token. */
  managerOwner: string;
  /** The enrolled agent's user owner (`u_…`). Must equal `managerOwner` when `delegated !== true`. */
  targetOwner: string;
  actor: string;
  /** Authoritative host-selected lifecycle UID. Absent only while `phase === "enrolling"`. */
  lifecycleUid?: string;
  /** Locally minted provisional UID where `staged.actorToken` is persisted during `phase === "enrolling"`. */
  provisionalUid?: string;
  /** SHA-256 hex digest of the staged `actorToken`, used for same-enrollment convergence when `phase === "enrolling"`. */
  tokenHash?: string;
  /** Enrollment parameters needed to re-invoke `enrollManagedAgent` idempotently when `phase === "enrolling"`. */
  enrollSpec?: ManagerSlotEnrollSpec;
  managerInstanceId: string;
  managerLifecycleUid: string;
  phase: ManagerSlotPhase;
  /** True when the manager released handle custody on `stop()` without `withAgents`. */
  released?: boolean;
  /** True when launched via `delegatedIntent` (SPEC §13.16): never retired via `prepareAgentRetirement`. */
  delegated?: boolean;
  /** Admitted delegated intent ID when `delegated === true`. */
  delegatedIntentId?: string;
  /** Durable runtime custody reference reserved via `CustodialRuntime.reserve()` before process launch. */
  runtime?: RuntimeReference;
  /** Kernel process identity of the spawned seat child on this host, when known. */
  process?: ManagerSlotProcess;
  /** Preservation attempt ID when `phase === "preserved"`. */
  preserveAttemptId?: string;
  /** Deterministic retirement opId (`managedRetirementOpId(lifecycleUid)`) when `phase === "releasing"`. */
  opId?: string;
  /** Set once `prepareAgentRetirement` (or local durable/grant cleanup) has succeeded for `lifecycleUid`. */
  cleanupComplete?: boolean;
  updatedAt: string;
}

export interface ManagerSlotIndexRecord {
  v: 1;
  space: string;
  managerOwner: string;
  suffixes: string[];
}

export interface UserReconcileMarkers {
  adoptedReleasedCount: number;
  deferredForResumeCount: number;
  adoptedResumeSkipCount: number;
  heldDelegatedSlotCount: number;
}

/** Validate `targetOwner` (`u_…`, no `-`) and `actor` (`[A-Za-z0-9_]+`, no `-`) and return the
 *  single-token suffix `<targetOwner>-<actor>` where `-` is the sole separator. */
export function userSlotSuffix(targetOwner: string, actor: string): string {
  return `${assertDerivedOwnerToken(targetOwner)}-${assertValidOwnerToken(actor)}`;
}

export function parseUserSlotSuffix(suffix: string): { targetOwner: string; actor: string } {
  const sep = suffix.indexOf("-");
  if (sep <= 0 || sep === suffix.length - 1)
    throw new Error(`invalid user slot suffix "${suffix}": expected "<targetOwner>-<actor>"`);
  const targetOwner = assertDerivedOwnerToken(suffix.slice(0, sep));
  const actor = assertValidOwnerToken(suffix.slice(sep + 1));
  return { targetOwner, actor };
}

export function userSlotKey(managerOwner: string, targetOwner: string, actor: string): string {
  const holder = assertPrincipalOwnerToken(managerOwner, { allowPlatform: true });
  return staticSlotKey(holder, userSlotSuffix(targetOwner, actor));
}

export function userSlotIndexKey(managerOwner: string): string {
  const holder = assertPrincipalOwnerToken(managerOwner, { allowPlatform: true });
  return staticSlotKey(holder, USER_SLOT_INDEX_TOKEN);
}

function localSlotIndexPath(workspaceRoot: string, space: string): string {
  return join(workspaceRoot, ".cotal", `space.${spaceKey(space)}`, "mgrslots.json");
}

export function readLocalSlotSuffixes(workspaceRoot: string, space: string): string[] {
  const path = localSlotIndexPath(workspaceRoot, space);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; suffixes?: unknown };
  if (raw.v !== 1 || !Array.isArray(raw.suffixes))
    throw new Error(`corrupt local mgrslot index at ${path}`);
  const out: string[] = [];
  for (const s of raw.suffixes) {
    if (typeof s !== "string") throw new Error(`corrupt suffix in local mgrslot index at ${path}`);
    parseUserSlotSuffix(s);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function recordLocalSlotSuffix(workspaceRoot: string, space: string, suffix: string): void {
  parseUserSlotSuffix(suffix);
  const path = localSlotIndexPath(workspaceRoot, space);
  const current = existsSync(path) ? readLocalSlotSuffixes(workspaceRoot, space) : [];
  if (current.includes(suffix)) return;
  current.push(suffix);
  current.sort();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, space, suffixes: current })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function parseSlotIndexRecord(bytes: Uint8Array, expectedSpace: string, expectedManagerOwner: string): ManagerSlotIndexRecord {
  const raw = JSON.parse(dec.decode(bytes)) as Partial<ManagerSlotIndexRecord>;
  if (raw.v !== 1 || raw.space !== expectedSpace || raw.managerOwner !== expectedManagerOwner || !Array.isArray(raw.suffixes))
    throw new Error(`corrupt mgrslot index for ${expectedManagerOwner} in space "${expectedSpace}"`);
  assertPrincipalOwnerToken(raw.managerOwner, { allowPlatform: true });
  const suffixes: string[] = [];
  for (const s of raw.suffixes) {
    if (typeof s !== "string") throw new Error(`corrupt suffix in mgrslot index for ${expectedManagerOwner}`);
    parseUserSlotSuffix(s);
    if (!suffixes.includes(s)) suffixes.push(s);
  }
  return { v: 1, space: expectedSpace, managerOwner: expectedManagerOwner, suffixes };
}

export async function ensureKvSlotSuffix(kv: KV, space: string, managerOwner: string, suffix: string): Promise<void> {
  assertPrincipalOwnerToken(managerOwner, { allowPlatform: true });
  parseUserSlotSuffix(suffix);
  const key = userSlotIndexKey(managerOwner);
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await kv.get(key);
    if (entry === null) {
      const next: ManagerSlotIndexRecord = { v: 1, space, managerOwner, suffixes: [suffix] };
      try {
        await kv.create(key, enc.encode(JSON.stringify(next)));
        return;
      } catch (e) {
        if (isCasLoss(e)) continue;
        throw e;
      }
    }
    if (entry.operation !== "PUT")
      throw new Error(`mgrslot index ${key} carries a ${entry.operation} marker; index rows are never deleted`);
    const current = parseSlotIndexRecord(entry.value, space, managerOwner);
    if (current.suffixes.includes(suffix)) return;
    const suffixes = [...current.suffixes, suffix].sort();
    const next: ManagerSlotIndexRecord = { v: 1, space, managerOwner, suffixes };
    try {
      await kv.update(key, enc.encode(JSON.stringify(next)), entry.revision);
      return;
    } catch (e) {
      if (isCasLoss(e)) continue;
      throw e;
    }
  }
  throw new Error(`could not update mgrslot index ${key} after concurrent contention`);
}

export async function listUserSlotSuffixes(kv: KV, workspaceRoot: string, space: string, managerOwner: string): Promise<string[]> {
  assertPrincipalOwnerToken(managerOwner, { allowPlatform: true });
  const key = userSlotIndexKey(managerOwner);
  const entry = await kv.get(key);
  const set = new Set<string>(readLocalSlotSuffixes(workspaceRoot, space));
  if (entry !== null) {
    if (entry.operation !== "PUT")
      throw new Error(`mgrslot index ${key} carries a ${entry.operation} marker; index rows are never deleted`);
    const parsed = parseSlotIndexRecord(entry.value, space, managerOwner);
    for (const s of parsed.suffixes) set.add(s);
  }
  return [...set].sort();
}

export function parseManagerSlotRecord(
  bytes: Uint8Array,
  expectedSpace: string,
  expectedManagerOwner: string,
  expectedSuffix: string,
): ManagerSlotRecord {
  const raw = JSON.parse(dec.decode(bytes)) as Partial<ManagerSlotRecord>;
  if (raw.v !== 1 || raw.space !== expectedSpace)
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: wrong version or space`);
  if (typeof raw.managerOwner !== "string" || raw.managerOwner !== expectedManagerOwner)
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: managerOwner mismatch`);
  assertPrincipalOwnerToken(raw.managerOwner, { allowPlatform: true });
  if (typeof raw.targetOwner !== "string")
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: missing targetOwner`);
  assertDerivedOwnerToken(raw.targetOwner);
  if (typeof raw.actor !== "string")
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: missing actor`);
  assertValidOwnerToken(raw.actor);
  if (userSlotSuffix(raw.targetOwner, raw.actor) !== expectedSuffix)
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: suffix does not match targetOwner-actor`);
  if (raw.delegated !== true && raw.targetOwner !== raw.managerOwner)
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: non-delegated targetOwner ${raw.targetOwner} !== managerOwner ${raw.managerOwner}`);
  if (typeof raw.managerInstanceId !== "string" || typeof raw.managerLifecycleUid !== "string")
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: missing manager instance coordinates`);
  assertLifecycleToken(raw.managerInstanceId, "mgrslot managerInstanceId");
  assertLifecycleToken(raw.managerLifecycleUid, "mgrslot managerLifecycleUid");
  if (
    raw.phase !== "enrolling" &&
    raw.phase !== "provisioning" &&
    raw.phase !== "active" &&
    raw.phase !== "preserved" &&
    raw.phase !== "releasing" &&
    raw.phase !== "retired"
  ) {
    throw new Error(`corrupt mgrslot record for ${expectedSuffix}: invalid phase ${String(raw.phase)}`);
  }
  if (raw.phase !== "enrolling") {
    if (typeof raw.lifecycleUid !== "string")
      throw new Error(`corrupt mgrslot record for ${expectedSuffix}: phase ${raw.phase} requires lifecycleUid`);
    assertLifecycleToken(raw.lifecycleUid, "mgrslot lifecycleUid");
  }
  return raw as ManagerSlotRecord;
}

export async function readUserSlot(
  kv: KV,
  space: string,
  managerOwner: string,
  targetOwner: string,
  actor: string,
): Promise<{ row: ManagerSlotRecord; revision: number } | undefined> {
  const suffix = userSlotSuffix(targetOwner, actor);
  const key = userSlotKey(managerOwner, targetOwner, actor);
  const entry = await kv.get(key);
  if (entry === null) return undefined;
  if (entry.operation !== "PUT")
    throw new Error(`mgrslot row ${key} carries a ${entry.operation} marker; slot rows are never deleted`);
  return {
    row: parseManagerSlotRecord(entry.value, space, managerOwner, suffix),
    revision: entry.revision,
  };
}

/** Write a user slot row with a required compare-and-set revision: `expectedRevision === 0`
 *  creates the row when absent (`kv.create`); `expectedRevision > 0` updates against that exact
 *  KV revision (`kv.update`). Never performs an unpinned overwrite. */
export async function writeUserSlot(
  kv: KV,
  workspaceRoot: string,
  space: string,
  row: ManagerSlotRecord,
  expectedRevision: number,
): Promise<number> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
    throw new Error(`writeUserSlot requires a non-negative integer expectedRevision (got ${String(expectedRevision)})`);
  const suffix = userSlotSuffix(row.targetOwner, row.actor);
  parseManagerSlotRecord(enc.encode(JSON.stringify(row)), space, row.managerOwner, suffix);
  recordLocalSlotSuffix(workspaceRoot, space, suffix);
  await ensureKvSlotSuffix(kv, space, row.managerOwner, suffix);
  const key = userSlotKey(row.managerOwner, row.targetOwner, row.actor);
  const payload = enc.encode(JSON.stringify(row));
  if (expectedRevision === 0) {
    return await kv.create(key, payload);
  }
  return await kv.update(key, payload, expectedRevision);
}
