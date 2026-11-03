import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ensureDirNoSymlink, mkSecretDir, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { stopReservationPath } from "./local-process.js";
import { assertRecordIdentity, defaultStartToken, formatRecord, parsePid, parseRecord, type ProcessIdentityRecord } from "./pid.js";

export interface LocalStopAttempt {
  target: { pid: number; token?: string };
  stopper: { pid: number; marker: string };
}

function channel(pidPath: string, target: ProcessIdentityRecord): { ready: string; request: string } {
  const key = createHash("sha256").update(formatRecord(target)).digest("base64url");
  const prefix = join(dirname(pidPath), "local-stop", `${basename(pidPath)}.${key}`);
  return { ready: `${prefix}.ready`, request: `${prefix}.request` };
}

function reservation(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("local stop reservation is not a regular file");
  return `${stat.dev}:${stat.ino}`;
}

function metadata(path: string): Record<string, unknown> {
  if (!lstatSync(path).isFile()) throw new Error("local stop metadata is not a regular file");
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("local stop metadata is not a regular file");
    const bytes = Buffer.alloc(4097);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error("local stop metadata exceeds 4096 bytes");
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw new Error("local stop metadata is malformed"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("local stop metadata is malformed");
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/** Publish a process-bound local control capability before publishing the daemon's pid record.
 * The private nonce is required even in a writable workspace: a public pid/start token alone must
 * not let another OS user trigger an elevated daemon's cleanup. Consume the request before invoking
 * cleanup, including a callback that exits synchronously. Hosted services do not call this. */
export function listenForLocalStop(pidPath: string, onStop: () => void): () => void {
  const token = defaultStartToken(process.pid);
  if (token === undefined) throw new Error("cannot advertise local stop without a process creation identity");
  const target = { pid: process.pid, token };
  const paths = channel(pidPath, target);
  const secret = randomBytes(32).toString("hex");
  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 });
  mkSecretDir(ensureDirNoSymlink(dirname(pidPath), "local-stop"));
  writeSecretFileCreateOnly(paths.ready, JSON.stringify({ version: 1, target: formatRecord(target), token: secret }));
  const timer = setInterval(() => {
    let verified = false;
    const claimed = `${paths.request}.${process.pid}.${randomBytes(8).toString("hex")}.consuming`;
    try { renameSync(paths.request, claimed); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("! could not claim local stop request");
      return;
    }
    try {
      const row = metadata(claimed);
      if (Object.keys(row).sort().join(",") !== "reservation,stopper,target,token,version" || row.version !== 1 ||
          row.target !== formatRecord(target) || typeof row.token !== "string" || !/^[a-f0-9]{64}$/.test(row.token) ||
          !timingSafeEqual(Buffer.from(row.token, "hex"), Buffer.from(secret, "hex")) || typeof row.stopper !== "string" ||
          typeof row.reservation !== "string") return;
      const stopper = parseRecord(row.stopper);
      if (stopper.kind !== "record" || assertRecordIdentity(stopper.record).kind !== "match") return;
      const marker = stopReservationPath(pidPath);
      if (reservation(marker) !== row.reservation || parsePid(readFileSync(marker, "utf8")) !== stopper.record.pid) return;
      clearInterval(timer);
      verified = true;
    } catch {
      console.error("! ignored local stop request that could not be verified");
    } finally {
      rmSync(claimed, { force: true });
    }
    if (verified) onStop();
  }, 100);
  timer.unref();
  const dispose = (): void => {
    clearInterval(timer);
    process.off("exit", dispose);
    rmSync(paths.ready, { force: true });
    rmSync(paths.request, { force: true });
  };
  process.once("exit", dispose);
  return dispose;
}

/** Request cleanup only after the caller verified its target and while it holds that target's stop
 * reservation. Cleanup stays under the reservation, so it cannot remove a later caller's request.
 * Generation-specific paths keep a predecessor's cleanup away from a successor's capability. */
export function requestLocalStop(pidPath: string, attempt: LocalStopAttempt): (gone: boolean) => void {
  if (attempt.target.token === undefined) throw new Error("local cooperative stop requires a pinned process identity");
  const target = { pid: attempt.target.pid, token: attempt.target.token };
  const marker = stopReservationPath(pidPath);
  if (attempt.stopper.pid !== process.pid || attempt.stopper.marker !== marker || parsePid(readFileSync(marker, "utf8")) !== process.pid)
    throw new Error("local cooperative stop does not own the active stop reservation");
  const identity = reservation(marker);
  const paths = channel(pidPath, target);
  let row: Record<string, unknown>;
  try { row = metadata(paths.ready); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("this daemon does not advertise cooperative shutdown; stop it with its original supervisor, then restart with this version");
  }
  if (Object.keys(row).sort().join(",") !== "target,token,version" || row.version !== 1 || row.target !== formatRecord(target) ||
      typeof row.token !== "string" || !/^[a-f0-9]{64}$/.test(row.token))
    throw new Error("local cooperative stop capability does not match the verified process");
  const token = defaultStartToken(process.pid);
  if (token === undefined || reservation(marker) !== identity || parsePid(readFileSync(marker, "utf8")) !== process.pid)
    throw new Error("local cooperative stop cannot verify its reservation owner");
  writeSecretFileCreateOnly(paths.request, JSON.stringify({ version: 1, target: formatRecord(target), token: row.token,
    stopper: formatRecord({ pid: process.pid, token }), reservation: identity }));
  return (gone) => {
    rmSync(paths.request, { force: true });
    if (gone) rmSync(paths.ready, { force: true });
  };
}
