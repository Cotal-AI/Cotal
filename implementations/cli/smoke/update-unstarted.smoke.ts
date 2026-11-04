/** Prepared and stopped-controller projects must prove they have no live custody before update. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshTarget } from "@cotal-ai/workspace";
import { isStoppedLocalMesh, readManagerContinuity } from "../src/commands/update.js";
import { recordPreparedSpace, setCurrent } from "@cotal-ai/workspace";
import { writeStackJournal, STACK_ROLES, type StackJournal } from "../src/lib/stack-journal.js";
import { serviceInstanceStore, processServiceHost, requireProcessIdentity } from "../src/lib/service-instances.js";

const root = mkdtempSync(join(tmpdir(), "cotal-update-unstarted-"));
const prior = process.env.COTAL_HOME;
process.env.COTAL_HOME = join(root, "home");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const listener = createServer((socket) => socket.end());
await new Promise<void>((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const address = listener.address();
assert.ok(address && typeof address !== "string");
const target: MeshTarget = {
  root,
  server: `nats://127.0.0.1:${address.port}`,
  space: `update-${randomUUID()}`,
  mode: "open",
  tlsRequired: false,
  personaRoot: join(root, ".cotal", "agents"),
  source: "local-space",
};
try {
  assert.equal(await isStoppedLocalMesh(target), false, "a live listener prevents an unstarted-project shortcut");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  assert.equal(await isStoppedLocalMesh(target), true, "an unregistered project with no listener or supervisor has no custody");
  for (const source of ["flag-server", "flag-space-override", "registry", "current"] as const)
    assert.equal(await isStoppedLocalMesh({ ...target, source }), false, `${source} requires a local registration`);
  // A completed controller down removes its registration. Exercise the resolver's real
  // not-started refusal rather than passing a hand-built MeshTarget around it.
  recordPreparedSpace({ space: target.space, root, ts: new Date().toISOString() });
  const journal: StackJournal = {
    schemaVersion: 1, kind: "cotal-stack-controller", root, space: target.space, server: target.server, mode: "open",
    members: STACK_ROLES.map((role) => ({ role, definition: `stack-${role}`, instanceId: null, state: "not-attempted" })),
    operation: { id: randomUUID(), kind: "down", phase: "completed", recordedAt: new Date().toISOString(), withAgents: false },
    updatedAt: new Date().toISOString(),
  };
  // A prior member ID makes the prepared lifecycle report stopped, as a real down does.
  journal.members[0] = { ...journal.members[0]!, instanceId: randomUUID(), state: "already-stopped" };
  const id = journal.members[0]!.instanceId!;
  const store = serviceInstanceStore(target.space);
  store.commit(id, undefined, {
    schemaVersion: 1, instanceId: id, definition: "stack-broker", definitionRevision: randomUUID(), space: target.space,
    host: processServiceHost(), launcher: requireProcessIdentity(process.pid), state: "stopped",
    requestId: randomUUID(), launchRequestId: randomUUID(), readiness: "not-checked", supervisor: "none", foreground: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  let instance = store.read(id)!;
  let snapshot = writeStackJournal(root, undefined, journal);
  const cwd = process.cwd();
  try {
    process.chdir(root);
    assert.equal(await readManagerContinuity({ space: target.space }), "none", "a named completed-down controller has no running custody");
    setCurrent(target.space);
    assert.equal(await readManagerContinuity({}), "none", "an in-folder selected completed-down controller has no running custody");
    await assert.rejects(readManagerContinuity({ space: target.space, server: target.server }), "an explicit server never takes the stopped-controller shortcut");
    await assert.rejects(readManagerContinuity({ space: target.space, creds: join(root, "missing.creds") }), "explicit credentials never take the shortcut");
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(address.port, "127.0.0.1", resolve); });
    await assert.rejects(readManagerContinuity({ space: target.space }), "a listener at the stopped controller address blocks update");
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    snapshot = writeStackJournal(root, snapshot, { ...journal, operation: { ...journal.operation, phase: "applying" } });
    await assert.rejects(readManagerContinuity({ space: target.space }), "an unfinished down cannot claim cold-update eligibility");
    snapshot = writeStackJournal(root, snapshot, journal);
    const stopped = instance.record.value;
    store.commit(id, instance, { ...stopped, process: requireProcessIdentity(process.pid) });
    instance = store.read(id)!;
    await assert.rejects(readManagerContinuity({ space: target.space }), "a stopped record cannot hide its live process");
    store.commit(id, instance, { ...stopped, state: "starting" });
    instance = store.read(id)!;
    await assert.rejects(readManagerContinuity({ space: target.space }), "an unresolved launch prevents the shortcut");
    store.commit(id, instance, stopped);
    snapshot = writeStackJournal(root, snapshot, { ...journal, members: journal.members.map((member, index) => index === 0 ? { ...member, instanceId: randomUUID() } : member) });
    await assert.rejects(readManagerContinuity({ space: target.space }), "a member absent from this home's instance store prevents the shortcut");
    snapshot = writeStackJournal(root, snapshot, { ...journal, operation: { ...journal.operation, phase: "partial" } });
    await assert.rejects(readManagerContinuity({ space: target.space }), "a partial down cannot claim cold-update eligibility");
    writeStackJournal(root, snapshot, journal);
    process.chdir(cwd);
    assert.equal(await readManagerContinuity({ space: target.space }), "none", "a named stopped controller is eligible from another folder");
  } finally { process.chdir(cwd); }
  console.log("update-unstarted.smoke: 17 checks passed");
} finally {
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (prior === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prior;
  rmSync(root, { recursive: true, force: true });
}
