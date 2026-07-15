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

export function readAuthority(): Authority | undefined {
  return readJsonFile<Authority>(authorityPath());
}

export function readAuthorityBackup(): Authority | undefined {
  return readJsonFile<Authority>(authorityBackupPath());
}

export function readWitness(): Witness | undefined {
  return readJsonFile<Witness>(witnessPath());
}

export function readStamp(): Stamp | undefined {
  return readJsonFile<Stamp>(stampPath());
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
