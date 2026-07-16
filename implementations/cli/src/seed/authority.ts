import { existsSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  authorityBackupPath,
  authorityPath,
  readJsonFile,
  stampPath,
  witnessPath,
  writeJsonAtomic,
} from "./paths.js";

/**
 * The three named seed-state files plus the durable authority backup, and the monotonic contract
 * that keeps a deliberately-removed connector removed across a version bump.
 *
 * `ever-seeded` is the authority: the set of built-ins that were EVER seeded. It only grows. A name
 * in it but absent from the extensions manifest was removed on purpose (leave it removed); a name
 * NOT in it was never seeded (seed it). Losing this set would resurrect removals, so it is mirrored
 * into an append-only backup — the only thing `--repair` can recover from. Write order per reconcile:
 * authority (with its backup) first, then the witness, then the stamp LAST, so a stamp is never
 * current ahead of the authority it certifies.
 */

export interface Authority {
  /** Built-in connector names ever seeded on this machine. Monotonic — never shrinks. */
  readonly everSeeded: string[];
}

export interface Witness {
  readonly initialized: true;
  /** The generation that first initialized this prefix (diagnostic; the stamp tracks the latest). */
  readonly firstGeneration: string;
}

export interface Stamp {
  /** The generation the last completed reconcile ran for. */
  readonly generation: string;
}

/** Every seed-state file is schema-validated on read: a syntactically-valid but wrong-shaped file is
 *  as dangerous as corrupt JSON (a truncated authority would resurrect removed connectors), so it is
 *  rejected the same way — loud, with the repair hint — never silently treated as a smaller set. */
function validate<T>(path: string, value: T | undefined, ok: (v: unknown) => boolean): T | undefined {
  if (value === undefined) return undefined;
  if (!ok(value)) throw new Error(`corrupt seed state ${path}: unexpected shape - repair with \`cotal ext seed --repair\` (or --reset)`);
  return value;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

export function readAuthority(): Authority | undefined {
  return validate(authorityPath(), readJsonFile<Authority>(authorityPath()), (v) => isStringArray((v as Authority).everSeeded));
}

export function readAuthorityBackup(): Authority | undefined {
  return validate(authorityBackupPath(), readJsonFile<Authority>(authorityBackupPath()), (v) => isStringArray((v as Authority).everSeeded));
}

export function readWitness(): Witness | undefined {
  return validate(witnessPath(), readJsonFile<Witness>(witnessPath()), (v) => (v as Witness).initialized === true && typeof (v as Witness).firstGeneration === "string");
}

export function readStamp(): Stamp | undefined {
  return validate(stampPath(), readJsonFile<Stamp>(stampPath()), (v) => typeof (v as Stamp).generation === "string");
}

/** The ever-seeded set unioned with its monotonic backup. A live authority that lost ids (a truncated
 *  or partially-corrupt write that still parsed) can only SHRINK the set; the backup is a superset, so
 *  unioning it on read means a deliberately-removed connector is never resurrected by such a loss.
 *  Returns undefined only when BOTH are absent (the genuinely-lost case the caller must fail loud on). */
export function everSeededUnion(): Set<string> | undefined {
  const live = readAuthority()?.everSeeded;
  const backup = readAuthorityBackup()?.everSeeded;
  if (live === undefined && backup === undefined) return undefined;
  return new Set([...(live ?? []), ...(backup ?? [])]);
}

/**
 * Persist the ever-seeded authority. The backup is updated FIRST as a monotonic UNION (old backup ∪
 * new set), so the recovery source is always a superset of the live authority and a crash between the
 * two writes can only lose ids from the authority (which the backup then restores), never from both.
 * An older binary that reads this must union unknown ids, never drop them.
 */
export function writeAuthority(everSeeded: Set<string>): void {
  const prior = readAuthorityBackup()?.everSeeded ?? [];
  const union = [...new Set([...prior, ...everSeeded])].sort();
  writeJsonAtomic(authorityBackupPath(), { everSeeded: union });
  writeJsonAtomic(authorityPath(), { everSeeded: [...everSeeded].sort() });
}

/** Write the initialization witness once (idempotent; refreshing it would erase the first-seen gen). */
export function ensureWitness(generation: string): void {
  if (!readWitness()) writeJsonAtomic(witnessPath(), { initialized: true, firstGeneration: generation });
}

/** Write the version stamp LAST — the only thing that flips the fast path to "reconcile complete". */
export function writeStamp(generation: string): void {
  writeJsonAtomic(stampPath(), { generation });
}

/** Recover a lost authority from the durable backup (for `--repair`). Undefined when even the backup
 *  is gone — the caller REFUSES, because a witness alone cannot tell a removed connector from a
 *  never-seeded future one. */
export function recoverAuthorityFromBackup(): Set<string> | undefined {
  const backup = readAuthorityBackup();
  return backup ? new Set(backup.everSeeded) : undefined;
}

/** Move aside any seed-state file that no longer reads/validates, so a `--reset` can rebuild clean
 *  state instead of wedging when a commit helper re-reads the same corrupt file. Returns the
 *  quarantine paths (for reporting). `--reset` overwrites authority/backup/witness/stamp anyway; this
 *  just guarantees the pre-write reads (e.g. {@link ensureWitness}) can't throw on a corrupt one. */
export function quarantineCorruptSeedState(): string[] {
  const readers: Array<[string, () => unknown]> = [
    [authorityPath(), readAuthority],
    [authorityBackupPath(), readAuthorityBackup],
    [witnessPath(), readWitness],
    [stampPath(), readStamp],
  ];
  const quarantined: string[] = [];
  for (const [path, read] of readers) {
    if (!existsSync(path)) continue;
    try {
      read();
    } catch {
      const aside = `${path}.corrupt.${randomBytes(4).toString("hex")}`;
      renameSync(path, aside);
      quarantined.push(aside);
    }
  }
  return quarantined;
}
