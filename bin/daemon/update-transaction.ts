import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, type DaemonPaths } from "./endpoint.js";

export type UpdateTransactionPhase = "preparing" | "fenced" | "blocked" | "aborted";
export interface UpdateTransactionIdentity {
  readonly attemptId: string;
  readonly owner: string;
  readonly installedCoordinate: string;
  readonly targetVersion: string;
  readonly packageSha256: string;
  readonly scope: "current-user";
}
export interface UpdateTransactionRecord extends UpdateTransactionIdentity {
  readonly version: 1;
  readonly revision: number;
  readonly phase: UpdateTransactionPhase;
}

const identityKeys = ["attemptId", "owner", "installedCoordinate", "targetVersion", "packageSha256", "scope"] as const;
const recordKeys = ["version", ...identityKeys, "revision", "phase"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Update transaction must be an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !keys.includes(key)))
    throw new Error("Update transaction has unsupported or missing fields");
  return result;
}
function identity(value: unknown): UpdateTransactionIdentity {
  const o = object(value, identityKeys);
  if (typeof o.attemptId !== "string" || !uuid.test(o.attemptId) || !bounded(o.owner, 512) || !bounded(o.targetVersion, 128)
    || typeof o.installedCoordinate !== "string" || !sha256.test(o.installedCoordinate)
    || typeof o.packageSha256 !== "string" || !sha256.test(o.packageSha256) || o.scope !== "current-user")
    throw new Error("Update transaction identity is invalid");
  return { attemptId: o.attemptId, owner: o.owner, installedCoordinate: o.installedCoordinate, targetVersion: o.targetVersion, packageSha256: o.packageSha256, scope: o.scope };
}
function record(value: unknown): UpdateTransactionRecord {
  const o = object(value, recordKeys);
  const tuple = identity(Object.fromEntries(identityKeys.map(key => [key, o[key]])));
  if (o.version !== 1 || !Number.isSafeInteger(o.revision) || Number(o.revision) < 1
    || (o.phase !== "preparing" && o.phase !== "fenced" && o.phase !== "blocked" && o.phase !== "aborted"))
    throw new Error("Update transaction revision or phase is invalid");
  return { version: 1, ...tuple, revision: Number(o.revision), phase: o.phase };
}

/**
 * Admission journal foundation only, with no installer or apply authority.
 * The caller must hold this daemon home's exclusive lifetime lock for the entire
 * instance lifetime. Synchronous methods serialize within that owner, not across processes.
 * Inputs must come from authenticated server peer identity and a verified installed coordinate.
 * Callers must inspect returned phases, including idempotent begin results.
 * Aborted means preparation was cancelled before any installer exists. Blocked has no exit.
 * A write failure poisons this instance. A new instance can recover only by flushing
 * the retained file and parent again. This is not a power-loss qualification.
 */
export class UpdateTransactionJournal {
  readonly file: string;
  private poisoned = false;
  constructor(private readonly paths: DaemonPaths) {
    this.file = join(paths.state, "update-transaction.json");
  }

  read(): UpdateTransactionRecord | undefined {
    this.assertWritable();
    ensureStateDir(this.paths);
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192 || (process.platform !== "win32" && (stat.uid !== process.geteuid!() || (stat.mode & 0o777) !== 0o600)))
        throw new Error("Update transaction journal must be a private owned regular file");
      const saved = record(JSON.parse(readFileSync(fd, "utf8")));
      fsyncSync(fd);
      const directory = openSync(this.paths.state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return saved;
    } finally { closeSync(fd); }
  }

  begin(value: UpdateTransactionIdentity): UpdateTransactionRecord {
    this.assertWritable();
    const tuple = identity(value);
    const previous = this.read();
    if (previous) {
      if (identityKeys.some(key => previous[key] !== tuple[key])) throw new Error("Update transaction identity conflicts with retained journal");
      return previous;
    }
    const next = record({ version: 1, ...tuple, revision: 1, phase: "preparing" });
    this.write(next);
    return next;
  }

  advance(attemptId: string, owner: string, expectedRevision: number, phase: UpdateTransactionPhase): UpdateTransactionRecord {
    this.assertWritable();
    const previous = this.read();
    if (!previous || previous.attemptId !== attemptId || previous.owner !== owner) throw new Error("Update transaction owner or attempt does not match");
    if (!Number.isSafeInteger(expectedRevision) || previous.revision !== expectedRevision) throw new Error("Update transaction revision conflict");
    const allowed = previous.phase === "preparing" ? ["fenced", "blocked", "aborted"] : previous.phase === "fenced" ? ["blocked", "aborted"] : [];
    if (!allowed.includes(phase)) throw new Error("Update transaction phase transition is refused");
    const next = record({ ...previous, revision: previous.revision + 1, phase });
    this.write(next);
    return next;
  }

  private assertUsable(): void {
    if (this.poisoned) throw new Error("Update transaction journal requires a new instance recovery read after a failed write");
  }

  private assertWritable(): void {
    this.assertUsable();
    if (process.platform === "win32") throw new Error("Update transaction journal requires reviewed Windows native DACL, reparse and durability primitives");
    if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Update transaction journal writes are unsupported on this platform");
  }

  private write(value: UpdateTransactionRecord): void {
    this.assertWritable();
    try { this.writeOnce(value); }
    catch (error) { this.poisoned = true; throw error; }
  }

  private writeOnce(value: UpdateTransactionRecord): void {
    ensureStateDir(this.paths);
    const directory = openSync(this.paths.state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const temporary = join(this.paths.state, `.update-transaction-${randomUUID()}.tmp`);
    let created = false;
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        writeFileSync(fd, `${JSON.stringify(value)}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      created = false;
      fsyncSync(directory);
    } finally {
      try { if (created) unlinkSync(temporary); }
      finally { closeSync(directory); }
    }
  }
}
