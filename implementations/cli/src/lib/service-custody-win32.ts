import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFileCreateOnly } from "@cotal-ai/core";
import { assertRecordIdentity, CommandFailure, custodyRequest, custodyStatus, isCommandFailure, readLocalRecordSource, startWin32Custodian, type CustodyRequest, type CustodyStatus, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { instanceProjection, serviceInstanceStore, type ServiceCustody, type ServiceInstance, type ServiceInstanceSnapshot } from "./service-instances.js";

/** Windows runs each process service under a custodian that holds its job; no other platform does. */
export const custodiedPlatform = () => process.platform === "win32";

function capabilityPath(space: string, name: string): string {
  const directory = serviceInstanceStore(space).directory(true);
  if (!directory) throw new CommandFailure("refused", "PERMISSION_DENIED", "the service instance store has no directory for a custody capability");
  return join(directory, name);
}

/** Create the background log a custodian appends to, protected like every Cotal secret file, and
 *  return where this launch's lines start. An existing log is reused only as a regular file. */
export function custodyLog(path: string): number {
  try { writeSecretFileCreateOnly(path, ""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("unprotected log target");
  return info.size;
}

/** Start `launch` under a new custodian. The capability goes to a new protected file beside the
 *  instance records and to the custodian on stdin; the record keeps only that file's name. `spawned`
 *  receives the custody as soon as the custodian runs, so an interrupted launch can still record it. */
export async function startCustodiedService(value: ServiceInstance, launch: { program: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }, log: string, spawned: (custody: ServiceCustody) => void): Promise<{ custody: ServiceCustody; process: ProcessIdentityRecord }> {
  const key = randomBytes(32), capability = `custody-${randomUUID()}.key`;
  writeSecretFileCreateOnly(capabilityPath(value.space, capability), key.toString("base64"));
  const started = await startWin32Custodian({ ...launch, log, instanceId: value.instanceId }, key, (custodian, pipe) => spawned({ custodian, pipe, capability }));
  return { custody: { custodian: started.custodian, pipe: started.pipe, capability }, process: started.process };
}

/** Ask the instance's custodian, only while its recorded pin still names it. The answer must name
 *  that custodian and the program this instance records. */
export async function askCustodian(row: ServiceInstanceSnapshot, request: CustodyRequest): Promise<CustodyStatus> {
  const value = row.record.value, custody = value.custody;
  const unknown = (detail: string) => new CommandFailure("unknown", "OPERATION_UNKNOWN", `${detail}; no process effect was attributed`, { target: instanceProjection(row) });
  if (!custody || assertRecordIdentity(custody.custodian).kind !== "match") throw unknown("the instance's custodian is not running");
  const bytes = readLocalRecordSource(capabilityPath(value.space, custody.capability), 128, true);
  const key = bytes === undefined ? Buffer.alloc(0) : Buffer.from(bytes.toString("utf8").trim(), "base64");
  if (key.length !== 32) throw unknown("the instance's custody capability is missing or damaged");
  let status: CustodyStatus;
  try { status = custodyStatus(await custodyRequest(custody.pipe, key, value.instanceId, request), custody.custodian); }
  catch (error) { throw isCommandFailure(error) ? error : unknown(`the instance's custodian did not answer: ${(error as Error).message}`); }
  if (value.process && (status.root.pid !== value.process.pid || status.root.token !== value.process.token)) throw unknown("the custodian holds another program than this instance records");
  return status;
}

/** Remove a custody's capability file once its custodian is gone. */
export function removeCustodyCapability(space: string, custody: ServiceCustody | undefined): void {
  if (!custody || assertRecordIdentity(custody.custodian).kind === "match") return;
  rmSync(capabilityPath(space, custody.capability), { force: true });
}
