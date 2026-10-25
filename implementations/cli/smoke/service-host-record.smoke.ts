/** The execution host and custody an instance record carries. A Windows record names the account's SID,
 *  its system ID's source and its custodian instead of a UID and boot ID; a POSIX host reads it as
 *  another host's. Custody is refused on a POSIX record, and a malformed SID, source, pipe or capability
 *  name is refused. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "service-host-record-"));
process.env.COTAL_HOME = join(home, ".cotal");
const { observeServiceProcess, processServiceHost, requireProcessIdentity, serviceInstanceStore } = await import("../src/lib/service-instances.js");
let checks = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (!condition) console.error(`FAIL ${name}`, detail ?? "");
  assert.ok(condition, name);
  checks++;
  console.log(`PASS ${name}`);
};
const refused = (fn: () => unknown) => { try { fn(); return false; } catch (error) { return (error as { code?: string }).code === "SCHEMA_INVALID"; } };

try {
  assert.notEqual(process.platform, "win32", "this suite reads Windows records from a POSIX host");
  const space = "hostrecords", ts = new Date().toISOString(), self = requireProcessIdentity(process.pid);
  const custody = { custodian: self, pipe: `\\\\.\\pipe\\cotal-custody-${"a".repeat(32)}`, capability: `custody-${randomUUID()}.key` };
  const windowsHost = { platform: "win32" as const, machine: "b".repeat(64), machineSource: "uefi" as const, sid: "S-1-5-21-1004336348-1177238915-682003330-1001", name: "winhost" };
  const record = (host: unknown, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    return { id, value: { schemaVersion: 1, instanceId: id, definition: "svc", definitionRevision: "rev", space, host, requestId: id, launchRequestId: id, state: "running", launcher: self, process: self, readiness: "process-running", supervisor: "none", foreground: false, createdAt: ts, updatedAt: ts, ...extra } };
  };
  const store = serviceInstanceStore(space);
  const windows = record(windowsHost, { custody });
  store.commit(windows.id, undefined, windows.value as never);
  const read = store.read(windows.id)!.record.value;
  check("H1 a Windows record keeps its SID host and custody", read.host.sid === windowsHost.sid && read.host.uid === undefined && read.host.boot === undefined && read.custody?.capability === custody.capability, read);
  check("H2 a POSIX host reads a live Windows record as another host's, never running or gone", observeServiceProcess(read) === "foreign-host");
  check("H3 custody on a POSIX record is refused", refused(() => { const row = record(processServiceHost(), { custody }); store.commit(row.id, undefined, row.value as never); }));
  check("H4 a Windows record with a malformed SID, pipe or capability is refused",
    refused(() => { const row = record({ ...windowsHost, sid: "S-1-5-21-x" }); store.commit(row.id, undefined, row.value as never); }) &&
    refused(() => { const row = record(windowsHost, { custody: { ...custody, pipe: "\\\\.\\pipe\\other" } }); store.commit(row.id, undefined, row.value as never); }) &&
    refused(() => { const row = record(windowsHost, { custody: { ...custody, capability: "../custody.key" } }); store.commit(row.id, undefined, row.value as never); }));
  check("H5 a Windows host carries no UID or boot ID beside its SID", refused(() => { const row = record({ ...windowsHost, uid: 0 }); store.commit(row.id, undefined, row.value as never); }) &&
    refused(() => { const row = record({ ...windowsHost, boot: randomUUID() }); store.commit(row.id, undefined, row.value as never); }));
  check("H6 a Windows host names where its system ID came from, and only a source Windows documents",
    refused(() => { const { machineSource: _, ...unsourced } = windowsHost; const row = record(unsourced); store.commit(row.id, undefined, row.value as never); }) &&
    refused(() => { const row = record({ ...windowsHost, machineSource: "none" }); store.commit(row.id, undefined, row.value as never); }) &&
    ["tpm", "registry"].every((machineSource) => { const row = record({ ...windowsHost, machineSource }); store.commit(row.id, undefined, row.value as never); return store.read(row.id)!.record.value.host.machineSource === machineSource; }));
  console.log(`SERVICE HOST RECORD OK (${checks} checks)`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
