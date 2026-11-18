/** Prepared and stopped-controller projects must prove they have no live custody before update. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MeshTarget } from "@cotal-ai/workspace";
import { isStoppedLocalMesh, readManagerContinuity } from "../src/commands/update.js";
import { findPreparedSpace, readCurrent, recordPreparedSpace, setCurrent } from "@cotal-ai/workspace";
import { writeStackJournal, STACK_ROLES, type StackJournal } from "../src/lib/stack-journal.js";
import { serviceInstanceStore, processServiceHost, requireProcessIdentity } from "../src/lib/service-instances.js";

const root = mkdtempSync(join(tmpdir(), "cotal-update-unstarted-"));
const other = mkdtempSync(join(tmpdir(), "cotal-update-deleted-"));
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
  // Use the public CLI to prepare and select a space that never starts, then delete
  // its project. Neither ordinary reconciliation nor repeated self-update needs it.
  const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
  const home = join(other, "home");
  mkdirSync(home, { mode: 0o700 });
  const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], {
    cwd: other, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_NO_UPDATE_CHECK: "1" },
    encoding: "utf8", timeout: 120_000,
  });
  const deleted = join(other, "project"), space = `deleted-${randomUUID()}`;
  mkdirSync(deleted, { mode: 0o700 });
  assert.equal(cli("space", "create", space, "--root", deleted).status, 0, "the CLI prepares the project");
  assert.equal(cli("use", space).status, 0, "the CLI selects the prepared project");
  const prepared = findPreparedSpace(space);
  rmSync(deleted, { recursive: true });
  for (const args of [["update"], ["update", "--self"], ["update", "--self"]]) {
    const run = cli(...args);
    assert.equal(run.status, 0, `${args.join(" ")} completes with a deleted selected project: ${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout.split("\n").filter(line => line.includes(`${space}: folder is gone`)).length, 1, "one line names the skipped space");
    assert.ok(run.stdout.includes("processes untouched, continuity not checked"), "update makes no continuity claim");
    assert.equal(readCurrent(), space, "update preserves the saved selection");
    assert.deepEqual(findPreparedSpace(space), prepared, "update preserves the prepared record");
    assert.equal(existsSync(deleted), false, "update does not recreate the project");
  }
  assert.equal(await readManagerContinuity({ space }, { readOnly: true, retainGraph: true }), "none", "staged pre-install skips the deleted prepared root too");
  await assert.rejects(readManagerContinuity({ space, creds: join(other, "missing.creds") }), "explicit credentials still refuse");
  console.log("update-unstarted.smoke: 39 checks passed");
} finally {
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (prior === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prior;
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}
