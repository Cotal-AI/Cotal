/** A same-UID, request-bound local observation of a controller-owned native child. The controller
 *  writes one create-only request naming the exact pinned target; only that live process answers,
 *  with one create-only response bound to the same request, launch and its own creation identity.
 *  This is local custody evidence from the child itself. It is not an authenticated endpoint
 *  response, a wire grant or a signature, and it never replaces a broker-attributed read. */
import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { token, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { spaceKey } from "./auth-paths.js";
import { CommandFailure } from "./output.js";
import { assertRecordIdentity, identityRecord, type ProcessIdentityRecord } from "./pid.js";
import { decodeLocalJson, protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";
import { serviceOperationId, type ServiceAdapterContext } from "./service-adapter.js";

type ObservationContext = Pick<ServiceAdapterContext, "space" | "instanceId" | "launchRequestId" | "stateDirectory">;
export interface ServiceObservationRequest {
  schemaVersion: 1;
  space: string;
  instanceId: string;
  launchRequestId: string;
  requestId: string;
  target: ProcessIdentityRecord;
  requester: ProcessIdentityRecord;
  requestedAt: string;
}
export interface ServiceObservationResponse extends ServiceObservationRequest {
  process: ProcessIdentityRecord;
  payload: unknown;
  observedAt: string;
}

const LIMIT = 64 * 1024;
const requestKeys = ["schemaVersion", "space", "instanceId", "launchRequestId", "requestId", "target", "requester", "requestedAt"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const invalid = (): never => { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private service observation does not match this full process/launch/request; no other observation was adopted"); };
const time = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 100 || !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.now() + 1000) return invalid();
  return value;
};
function pinned(value: unknown): ProcessIdentityRecord {
  if (!object(value) || Object.keys(value).length !== 2 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || Number(value.pid) > 2_147_483_647 || typeof value.token !== "string" || value.token.length > 128 || !/^[0-9]+$/.test(value.token)) return invalid();
  return { pid: Number(value.pid), token: value.token };
}
function prefix(context: ObservationContext): string {
  if (!isAbsolute(context.stateDirectory) || context.stateDirectory.length > 4096 || /[\u0000-\u001f\u007f]/u.test(context.stateDirectory) || !context.space || context.space.length > 200 || token(context.space) !== context.space) return invalid();
  protectedLocalDirectory(context.stateDirectory);
  return `.${spaceKey(serviceOperationId(context.instanceId))}.${spaceKey(serviceOperationId(context.launchRequestId))}.`;
}
const requestPath = (context: ObservationContext, requestId: string) => join(context.stateDirectory, `${prefix(context)}${spaceKey(serviceOperationId(requestId))}.observe.json`);
const responsePath = (context: ObservationContext, requestId: string) => join(context.stateDirectory, `${prefix(context)}${spaceKey(serviceOperationId(requestId))}.observation.json`);

function parseRequest(input: unknown, context: ObservationContext): ServiceObservationRequest {
  if (!object(input) || Object.keys(input).length !== requestKeys.length || Object.keys(input).some((key) => !requestKeys.includes(key)) || input.schemaVersion !== 1 || input.space !== context.space || input.instanceId !== context.instanceId || input.launchRequestId !== context.launchRequestId || typeof input.requestId !== "string") return invalid();
  try { serviceOperationId(input.requestId); } catch { return invalid(); }
  return { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, requestId: input.requestId, target: pinned(input.target), requester: pinned(input.requester), requestedAt: time(input.requestedAt) };
}
const sameRequest = (a: ServiceObservationRequest, b: ServiceObservationRequest) => a.requestId === b.requestId && a.space === b.space && a.instanceId === b.instanceId && a.launchRequestId === b.launchRequestId && a.target.pid === b.target.pid && a.target.token === b.target.token && a.requester.pid === b.requester.pid && a.requester.token === b.requester.token && a.requestedAt === b.requestedAt;

/** Remove one exact private file only while it still holds the bytes this caller read or wrote. */
function removeExact(path: string, expected: Buffer): void {
  const current = readLocalRecordSource(path, LIMIT, true);
  if (current === undefined) return;
  if (!current.equals(expected)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a private observation file changed before cleanup; it was not removed");
  rmSync(path, { force: true });
}

/** Controller side. Publish one request for the exact live target, wait for that target's own
 *  bound response, then remove this request and its response. A timeout yields no evidence. */
export async function requestServiceObservation(context: ObservationContext, target: ProcessIdentityRecord, options: { timeoutMs: number; signal: AbortSignal }): Promise<{ payload: unknown; observedAt: string } | undefined> {
  const self = identityRecord(process.pid);
  if (!("token" in self)) throw new CommandFailure("refused", "UNSUPPORTED", "the observing controller has no creation-pinned identity; no observation was requested");
  const checkedTarget = pinned(target);
  if (assertRecordIdentity(checkedTarget).kind !== "match") return undefined;
  const request: ServiceObservationRequest = { schemaVersion: 1, space: context.space, instanceId: context.instanceId, launchRequestId: context.launchRequestId, requestId: randomUUID(), target: checkedTarget, requester: { pid: self.pid, token: self.token }, requestedAt: new Date().toISOString() };
  const requestBytes = Buffer.from(JSON.stringify(request) + "\n");
  const path = requestPath(context, request.requestId), answer = responsePath(context, request.requestId);
  writeSecretFileCreateOnly(path, requestBytes);
  try {
    const deadline = Date.now() + Math.max(1, Math.min(10_000, options.timeoutMs));
    while (Date.now() < deadline) {
      options.signal.throwIfAborted();
      const bytes = readLocalRecordSource(answer, LIMIT, true);
      if (bytes !== undefined) {
        const row = decodeLocalJson(bytes);
        if (!object(row) || Object.keys(row).length !== requestKeys.length + 3 || Object.keys(row).some((key) => ![...requestKeys, "process", "payload", "observedAt"].includes(key))) return invalid();
        const answered = parseRequest(Object.fromEntries(requestKeys.map((key) => [key, row[key]])), context), process_ = pinned(row.process), observedAt = time(row.observedAt);
        if (!sameRequest(answered, request) || process_.pid !== checkedTarget.pid || process_.token !== checkedTarget.token || Date.parse(observedAt) < Date.parse(request.requestedAt) || assertRecordIdentity(checkedTarget).kind !== "match") return invalid();
        removeExact(answer, bytes);
        return { payload: row.payload, observedAt };
      }
      if (assertRecordIdentity(checkedTarget).kind !== "match") return undefined;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  } finally { removeExact(path, requestBytes); }
}

/** Child side. Answer every pending request addressed to this exact process and launch. A request
 *  for another process, a malformed one or an already-answered one is left untouched. */
export function answerServiceObservations(context: ObservationContext, payload: () => unknown): void {
  const self = identityRecord(process.pid);
  if (!("token" in self)) return;
  const start = prefix(context);
  for (const name of readdirSync(context.stateDirectory)) {
    if (!name.startsWith(start) || !name.endsWith(".observe.json")) continue;
    let request: ServiceObservationRequest;
    try {
      const bytes = readLocalRecordSource(join(context.stateDirectory, name), LIMIT, true);
      if (!bytes) continue;
      request = parseRequest(decodeLocalJson(bytes), context);
    } catch { continue; }
    if (request.target.pid !== self.pid || request.target.token !== self.token || join(context.stateDirectory, name) !== requestPath(context, request.requestId) || readLocalRecordSource(responsePath(context, request.requestId), LIMIT, true) !== undefined) continue;
    const body = payload();
    if (body === undefined) continue;
    const response: ServiceObservationResponse = { ...request, process: { pid: self.pid, token: self.token }, payload: body, observedAt: new Date().toISOString() };
    const text = JSON.stringify(response) + "\n";
    if (Buffer.byteLength(text) > LIMIT) throw new CommandFailure("refused", "SCHEMA_INVALID", "the service observation exceeds its bounded size; no response was published");
    try { writeSecretFileCreateOnly(responsePath(context, request.requestId), text); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
