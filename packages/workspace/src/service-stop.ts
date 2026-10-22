import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { token, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";
import { CommandFailure } from "./output.js";
import { assertRecordIdentity, identityRecord, type ProcessIdentityRecord } from "./pid.js";
import { decodeLocalJson, protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";
import { serviceOperationId, type ServiceAdapterContext } from "./service-adapter.js";

type StopContext = Pick<ServiceAdapterContext, "space" | "instanceId" | "launchRequestId" | "stateDirectory">;
export interface NativeServiceStopRequest {
  schemaVersion: 1;
  space: string;
  instanceId: string;
  launchRequestId: string;
  requestId: string;
  target: ProcessIdentityRecord;
  stopper: ProcessIdentityRecord;
  withAgents: boolean;
  scopeSha256: string;
  /** A preserved-exit stop only, with `withAgents: false`: the maintenance attempt and inventory
   *  digest the native child must still hold. Absent from ordinary requests. */
  preserved?: { attemptId: string; inventorySha256: string };
}
export interface NativeServiceStopReceipt extends NativeServiceStopRequest {
  phase: "accepted" | "refused" | "completed" | "failed";
  observedAt: string;
  /** A returned native stop is not proof that every lease, registration or family was cleaned. */
  cleanup: "not-checked";
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const invalid = (): never => { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private native stop record does not match this full process/launch/request; no other attempt was adopted"); };
const requestKeys = ["schemaVersion", "space", "instanceId", "launchRequestId", "requestId", "target", "stopper", "withAgents", "scopeSha256"];
/** The closed key list of one request: the ordinary nine, plus `preserved` when it is present. */
const keysOf = (input: Record<string, unknown>): readonly string[] => input.preserved === undefined ? requestKeys : [...requestKeys, "preserved"];
function preservedBinding(value: unknown): { attemptId: string; inventorySha256: string } {
  if (!object(value) || Object.keys(value).length !== 2 || typeof value.attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.attemptId) || typeof value.inventorySha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.inventorySha256)) return invalid();
  return { attemptId: value.attemptId, inventorySha256: value.inventorySha256 };
}
function pinned(value: unknown): ProcessIdentityRecord {
  if (!object(value) || Object.keys(value).length !== 2 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || Number(value.pid) > 2_147_483_647 || typeof value.token !== "string" || value.token.length > 128 || !/^[0-9]+$/.test(value.token)) return invalid();
  return { pid: Number(value.pid), token: value.token };
}
function contextKey(context: StopContext): string {
  if (!isAbsolute(context.stateDirectory) || context.stateDirectory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(context.stateDirectory) || !context.space || context.space.length > 200 || token(context.space) !== context.space) return invalid();
  protectedLocalDirectory(context.stateDirectory);
  return `.${spaceKey(serviceOperationId(context.instanceId))}.${spaceKey(serviceOperationId(context.launchRequestId))}`;
}
export const serviceStopRequestPath = (context: StopContext): string => join(context.stateDirectory, `${contextKey(context)}.stop.json`);
const receiptPath = (context: StopContext, requestId: string, phase: NativeServiceStopReceipt["phase"]): string => join(context.stateDirectory, `${contextKey(context)}.${spaceKey(serviceOperationId(requestId))}.${phase}.json`);

function request(input: unknown, context: StopContext): NativeServiceStopRequest {
  if (!object(input)) return invalid();
  const keys = keysOf(input);
  if (Object.keys(input).some((key) => !keys.includes(key)) || Object.keys(input).length !== keys.length || input.schemaVersion !== 1 || input.space !== context.space || input.instanceId !== context.instanceId || input.launchRequestId !== context.launchRequestId || typeof input.requestId !== "string" || typeof input.withAgents !== "boolean" || typeof input.scopeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.scopeSha256)) return invalid();
  try { serviceOperationId(input.requestId); } catch { return invalid(); }
  // A preserved-exit stop never reaps agents.
  const preserved = input.preserved === undefined ? undefined : preservedBinding(input.preserved);
  if (preserved && input.withAgents !== false) return invalid();
  return { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, requestId: input.requestId, target: pinned(input.target), stopper: pinned(input.stopper), withAgents: input.withAgents, scopeSha256: input.scopeSha256, ...(preserved ? { preserved } : {}) };
}
function sameRequest(a: NativeServiceStopRequest, b: NativeServiceStopRequest): boolean {
  return a.space === b.space && a.instanceId === b.instanceId && a.launchRequestId === b.launchRequestId && a.requestId === b.requestId && a.target.pid === b.target.pid && a.target.token === b.target.token && a.stopper.pid === b.stopper.pid && a.stopper.token === b.stopper.token && a.withAgents === b.withAgents && a.scopeSha256 === b.scopeSha256 &&
    (a.preserved === undefined ? b.preserved === undefined : b.preserved !== undefined && a.preserved.attemptId === b.preserved.attemptId && a.preserved.inventorySha256 === b.preserved.inventorySha256);
}

/** Call only while the native PID stop reservation and service definition hold are owned.
 *  The file is a same-UID local handoff, not a wire grant or a signature. It is never overwritten. */
export function publishServiceStopRequest(context: StopContext, value: NativeServiceStopRequest): void {
  const checked = request(value, context);
  const self = identityRecord(process.pid);
  if (!("token" in self) || checked.stopper.pid !== self.pid || checked.stopper.token !== self.token || assertRecordIdentity(checked.target).kind !== "match") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native stop handoff has no current creation-pinned caller and target; no request was published");
  writeSecretFileCreateOnly(serviceStopRequestPath(context), JSON.stringify(checked) + "\n");
}

/** Read from the native child before choosing any stop policy. A missing request authorizes nothing. */
export function readServiceStopRequest(context: StopContext): NativeServiceStopRequest | undefined {
  const bytes = readLocalRecordSource(serviceStopRequestPath(context), 8192, true);
  return bytes === undefined ? undefined : request(decodeLocalJson(bytes), context);
}

/** Native child only. Each phase is immutable and attributed to the original full request. */
export function publishServiceStopReceipt(context: StopContext, value: NativeServiceStopRequest, phase: NativeServiceStopReceipt["phase"]): void {
  const checked = request(value, context), self = identityRecord(process.pid);
  if (!("token" in self) || checked.target.pid !== self.pid || checked.target.token !== self.token || !["accepted", "refused", "completed", "failed"].includes(phase)) return invalid();
  writeSecretFileCreateOnly(receiptPath(context, checked.requestId, phase), JSON.stringify({ ...checked, phase, observedAt: new Date().toISOString(), cleanup: "not-checked" } satisfies NativeServiceStopReceipt) + "\n");
}

/** Read all present phases without replacing an unknown with mere process disappearance. */
export function readServiceStopReceipts(context: StopContext, expected: NativeServiceStopRequest): NativeServiceStopReceipt[] {
  const checked = request(expected, context), receipts: NativeServiceStopReceipt[] = [];
  for (const phase of ["accepted", "refused", "completed", "failed"] as const) {
    const bytes = readLocalRecordSource(receiptPath(context, checked.requestId, phase), 8192, true);
    if (bytes === undefined) continue;
    const row = decodeLocalJson(bytes);
    // A receipt row carries the expected request's own key list, `preserved` included iff it had one.
    const keys = keysOf(checked as unknown as Record<string, unknown>);
    if (!object(row) || Object.keys(row).length !== keys.length + 3 || Object.keys(row).some((key) => ![...keys, "phase", "observedAt", "cleanup"].includes(key)) || row.phase !== phase || row.cleanup !== "not-checked" || typeof row.observedAt !== "string" || row.observedAt.length > 100 || !Number.isFinite(Date.parse(row.observedAt)) || Date.parse(row.observedAt) > Date.now() + 1000) return invalid();
    const base = Object.fromEntries(keys.map((key) => [key, row[key]]));
    if (!sameRequest(request(base, context), checked)) return invalid();
    receipts.push({ ...checked, phase, observedAt: row.observedAt, cleanup: "not-checked" });
  }
  if (receipts.filter((row) => row.phase !== "accepted").length > 1 || receipts.some((row) => row.phase === "refused") && receipts.some((row) => row.phase === "accepted")) return invalid();
  const accepted = receipts.find((row) => row.phase === "accepted");
  if (receipts.some((row) => row.phase === "completed" || row.phase === "failed") && !accepted || accepted && receipts.some((row) => row.phase !== "accepted" && Date.parse(row.observedAt) < Date.parse(accepted.observedAt))) return invalid();
  return receipts;
}

/** Clear only this live caller's acknowledged no-stop handoff, still under its native reservation.
 *  Phase receipts stay retained. A submitted, failed or unknown stop cannot use this cleanup. */
export function clearRefusedServiceStopRequest(context: StopContext, expected: NativeServiceStopRequest): void {
  const checked = request(expected, context), self = identityRecord(process.pid);
  const current = readServiceStopRequest(context), phases = readServiceStopReceipts(context, checked);
  if (!("token" in self) || checked.stopper.pid !== self.pid || checked.stopper.token !== self.token || assertRecordIdentity(checked.target).kind !== "match" || !current || !sameRequest(current, checked) || phases.length !== 1 || phases[0]?.phase !== "refused") return invalid();
  rmSync(serviceStopRequestPath(context));
}

/** Remove a retained request whose only receipt is the child's refusal, once the stopper that
 *  published it is gone. Its phase receipts stay. Returns whether the request was removed. */
export function clearRetainedRefusedServiceStopRequest(context: StopContext, expected: NativeServiceStopRequest): boolean {
  const checked = request(expected, context), current = readServiceStopRequest(context);
  const phases = readServiceStopReceipts(context, checked), holder = assertRecordIdentity(checked.stopper).kind;
  if (!current || !sameRequest(current, checked) || phases.length !== 1 || phases[0]?.phase !== "refused" || holder !== "gone" && holder !== "mismatch") return false;
  rmSync(serviceStopRequestPath(context));
  return true;
}

/** Remove a retained request's reservation once the stopper that took it is gone. A marker that names
 *  another PID, is not a plain file, or whose stopper still runs or cannot be read, is kept. Returns
 *  whether no reservation remains. */
export function releaseRetainedServiceStop(marker: string, stopper: ProcessIdentityRecord): boolean {
  let current;
  try { current = lstatSync(marker); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  const holder = assertRecordIdentity(stopper).kind;
  if (!current.isFile() || readLocalRecordSource(marker, 128, true)?.toString("utf8") !== String(stopper.pid) || holder !== "gone" && holder !== "mismatch") return false;
  rmSync(marker);
  return true;
}

/** The new controller refuses every existing native reservation, including stale or malformed
 *  ones. It does not reuse the legacy PID-only reclaim path or silently steal another attempt. */
export function reserveNativeServiceStop(marker: string): { stopper: ProcessIdentityRecord; release(): void } {
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "this native stop reservation requires Linux process creation identity; no weaker platform path was selected");
  if (!isAbsolute(marker) || /[\u0000-\u001f\u007f]/u.test(marker)) throw new CommandFailure("refused", "USAGE_INVALID", "a native stop reservation needs its exact protected absolute marker path");
  protectedLocalDirectory(dirname(marker));
  const stopper = identityRecord(process.pid);
  if (!("token" in stopper) || !/^[0-9]+$/.test(stopper.token)) throw new CommandFailure("refused", "UNSUPPORTED", "this native stop requires a creation-pinned Linux caller; no PID-only reservation was substituted");
  const temp = `${marker}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeSecretFileCreateOnly(temp, String(process.pid));
  const original = lstatSync(temp);
  try {
    try { linkSync(temp, marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a native stop reservation already exists; inspect its original attempt before retrying. No marker was reclaimed or signal sent"); throw error; }
  } finally { rmSync(temp); }
  return { stopper, release() {
    let current;
    try { current = lstatSync(marker); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const bytes = readLocalRecordSource(marker, 128, true);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || bytes?.toString("utf8") !== String(stopper.pid)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native stop reservation changed; another marker was not removed");
    rmSync(marker);
  } };
}
