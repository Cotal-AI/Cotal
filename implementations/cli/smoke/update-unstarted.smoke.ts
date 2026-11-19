/** Updates skip retained legacy configurations without claiming continuity and prove stopped controllers cold. */
import "./update-isolation.js";
import nodeAssert from "node:assert/strict";
import { countedAssert } from "@cotal-ai/smoke-kit";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSpaceAuth } from "@cotal-ai/core";
import type { MeshTarget } from "@cotal-ai/workspace";
import { isStoppedLocalMesh, readManagerContinuity } from "../src/commands/update.js";
import { authDir, clearCurrent, findPreparedSpace, meshFile, readCurrent, recordMesh, recordPreparedSpace, removeMesh, saveSpaceAuth, setCurrent } from "@cotal-ai/workspace";
import { writeStackJournal, STACK_ROLES, type StackJournal } from "../src/lib/stack-journal.js";
import { serviceInstanceStore, processServiceHost, requireProcessIdentity } from "../src/lib/service-instances.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
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
    await assert.rejects(readManagerContinuity({ space: target.space, server: `tls://127.0.0.1:${address.port}` }), "a different broker URL cannot borrow the stopped-controller proof");
    await assert.rejects(readManagerContinuity({ space: target.space, creds: join(root, "missing.creds") }), "explicit credentials never take the shortcut");
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(address.port, "127.0.0.1", resolve); });
    await assert.rejects(readManagerContinuity({ space: target.space }), "a listener at the stopped controller address blocks update");
    await assert.rejects(readManagerContinuity({ space: target.space, server: target.server }), "a matching flag still requires the recorded endpoint to be unreachable");
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
    assert.equal(await readManagerContinuity({ space: target.space, server: target.server }), "none", "the recorded broker URL is eligible from another folder");
    assert.equal(await readManagerContinuity({ space: target.space, server: `${target.server}/` }), "none", "harmless URL spelling still selects the recorded broker");
  } finally { process.chdir(cwd); }
  // Native sudo regression: the controller journal belongs to a different account, and
  // its member records are not in the updater's home. Run this cell on the root test machine.
  if (process.getuid?.() === 0) {
    const ownHome = process.env.COTAL_HOME;
    const cwd = process.cwd();
    const before = readFileSync(join(root, ".cotal", "stack-controller.json"));
    try {
      process.env.COTAL_HOME = join(other, "foreign-reader");
      process.chdir(root);
      chownSync(join(root, ".cotal"), 65534, 65534);
      assert.equal(await readManagerContinuity({}), "none", "sudo leaves another account's implicit controller target untouched");
      assert.equal(await readManagerContinuity({}, { readOnly: true, retainGraph: true }), "none", "staged reads leave another account's controller untouched");
      await assert.rejects(readManagerContinuity({ server: target.server }), "an explicit server still refuses");
      await assert.rejects(readManagerContinuity({ space: target.space }), "an explicit space still refuses");
      await assert.rejects(readManagerContinuity({ creds: join(root, "missing.creds") }), "explicit credentials still refuse");
      chownSync(join(root, ".cotal"), 0, process.getgid!());
      await assert.rejects(readManagerContinuity({}), "missing member records in the same account still refuse");
      assert.deepEqual(readFileSync(join(root, ".cotal", "stack-controller.json")), before, "cross-account reads preserve the controller journal");
    } finally {
      chownSync(join(root, ".cotal"), 0, process.getgid!());
      process.env.COTAL_HOME = ownHome;
      process.chdir(cwd);
    }
  }
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
  // Use the public CLI to prepare and select a space that never starts, then delete
  // its project. Neither ordinary reconciliation nor repeated self-update needs it.
  const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
  const home = join(other, "home");
  mkdirSync(home, { mode: 0o700 });
  const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], {
    cwd: other, env: { ...ambient, HOME: home, USERPROFILE: home, COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(home, ".config"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_NO_UPDATE_CHECK: "1" },
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
  // Older up versions render these configurations before refusing an old broker binary.
  // Exercise the real resolver and built update commands against both retained formats.
  clearCurrent();
  const privateHome = join(root, "private-home");
  mkdirSync(privateHome, { mode: 0o700 });
  for (const mode of ["open", "static"] as const) {
    const project = join(root, `refused-${mode}`);
    mkdirSync(join(project, ".cotal"), { recursive: true, mode: 0o700 });
    if (mode === "static") saveSpaceAuth(authDir(project), await createSpaceAuth("refused"));
    const config = mode === "static" ? join(authDir(project), "server.conf") : join(project, ".cotal", "server-open.conf");
    const contents: string = `host: 127.0.0.1\nport: ${address.port}\n`;
    writeFileSync(config, contents, { mode: 0o600 });
    const cwd = process.cwd(), log = console.log;
    let output = "";
    try {
      process.chdir(project);
      console.log = (line?: unknown) => { output += `${line}\n`; };
      assert.equal(await readManagerContinuity({}, { readOnly: true, retainGraph: true }), "none", `${mode}: staged read skips retained configuration`);
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(address.port, "127.0.0.1", resolve); });
      assert.equal(await readManagerContinuity({}), "none", `${mode}: even a listener does not make retained configuration proof of custody`);
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await assert.rejects(readManagerContinuity({ creds: join(project, "missing.creds") }), `${mode}: explicit credentials keep their own refusal`);
    } finally { process.chdir(cwd); console.log = log; }
    assert.ok(output.includes(project), `${mode}: skip names the folder`);
    if (mode === "static") assert.ok(output.includes("refused:"), "static: skip names the space");
    assert.match(output, /records and processes untouched, continuity not checked/, `${mode}: no false continuity claim`);
    assert.doesNotMatch(output, /no manager running/, `${mode}: does not assert absence of custody`);
    for (const args of [["update"], ["update", "--self"]]) {
      const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../../../bin/dist/cotal.js"), ...args], {
        cwd: project, encoding: "utf8", timeout: 120_000,
        env: { ...ambient, HOME: privateHome, COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" },
      });
      assert.equal(result.status, 0, `${mode}: ${args.join(" ")} completes\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.includes(project), `${mode}: command names the skipped folder`);
      assert.match(result.stdout, /continuity not checked/, `${mode}: command reports the limitation`);
      assert.doesNotMatch(result.stderr, /running manager continuity check|start it again/, `${mode}: no circular start remedy`);
      assert.equal(readFileSync(config, "utf8"), contents, `${mode}: update preserves the rendered broker configuration`);
    }
  }
  // A clean legacy down also retains configuration when --space differs from the folder name.
  // Run the public startup and stop commands so this covers actual stopped-project records.
  const stoppedProject = join(root, "stopped-project");
  const stoppedSpace = `explicit-${randomUUID()}`;
  mkdirSync(join(stoppedProject, ".cotal"), { recursive: true, mode: 0o700 });
  const stoppedCli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], {
    cwd: stoppedProject, encoding: "utf8", timeout: 120_000,
    env: { ...ambient, HOME: privateHome, COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" },
  });
  let started = false;
  try {
    const up = stoppedCli("up", "--detach", "--server", target.server, "--space", stoppedSpace);
    started = up.status === 0;
    assert.equal(up.status, 0, `explicit-space project starts\n${up.stdout}\n${up.stderr}`);
    const sent = stoppedCli("send", "-c", "general", "hello");
    assert.equal(sent.status, 0, `explicit-space project stores a message\n${sent.stdout}\n${sent.stderr}`);
    const down = stoppedCli("down", "--yes");
    assert.equal(down.status, 0, `explicit-space project stops cleanly\n${down.stdout}\n${down.stderr}`);
    started = false;
    const config = join(authDir(stoppedProject), "server.conf");
    const contents = readFileSync(config, "utf8");
    const cwd = process.cwd();
    try {
      process.chdir(stoppedProject);
      assert.equal(await readManagerContinuity({}, { readOnly: true, retainGraph: true }), "none", "staged pre-install skips the stopped explicit-space project");
    } finally { process.chdir(cwd); }
    for (const args of [["update"], ["update", "--self"]]) {
      const result = stoppedCli(...args);
      assert.equal(result.status, 0, `stopped explicit-space ${args.join(" ")} completes\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.includes(stoppedProject), "update names the stopped project");
      assert.match(result.stdout, /continuity not checked/, "update does not claim continuity from retained records");
      assert.doesNotMatch(result.stderr, /running manager continuity check|start it again/, "no circular start remedy for a stopped project");
      assert.equal(readFileSync(config, "utf8"), contents, "update preserves the stopped project's broker configuration");
    }
  } finally {
    if (started) stoppedCli("down", "--yes");
  }
  // A controller down leaves a journal bound to its original root. Copies and renamed
  // folders must not become a prerequisite for updating software in this home.
  let controllerProject = join(root, "controller-old");
  const originalProject = controllerProject;
  const controllerSpace = `controller-${randomUUID()}`;
  const temp = join(root, "readonly-temp");
  mkdirSync(controllerProject, { mode: 0o700 });
  mkdirSync(temp, { mode: 0o500 });
  const controllerCli = (args: string[], temporary?: string) => spawnSync(process.execPath, [bin, ...args], {
    cwd: controllerProject, encoding: "utf8", timeout: 180_000,
    env: { ...ambient, HOME: privateHome, COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", ...(temporary ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary } : {}) },
  });
  const expectSuccess = (args: string[], temporary?: string) => {
    const result = controllerCli(args, temporary);
    assert.equal(result.status, 0, `${args.join(" ")} succeeds${temporary ? ` with TMPDIR=${temporary}` : ""}\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /OPERATION_UNKNOWN|Outcome unconfirmed|registry cannot be reached|version check failed/);
    return result;
  };
  try {
    expectSuccess(["space", "create", controllerSpace]);
    const up = controllerCli(["up", "--detach", "--server", target.server]);
    started = up.status === 0;
    assert.equal(up.status, 0, `${up.stdout}\n${up.stderr}`);
    expectSuccess(["down", "--yes"]);
    started = false;
    expectSuccess(["use", "--clear"]);
    const journalPath = join(".cotal", "stack-controller.json");
    const journalBefore = readFileSync(join(controllerProject, journalPath));
    // Older releases could leave another stopped space registered at this address. Current up
    // guards against creating the duplicate, so record the historical entry after stopping.
    const sharingSpace = `sharing-${randomUUID()}`;
    recordMesh({ space: sharingSpace, root: join(root, "renamed-away"), server: target.server, mode: "open", origin: "up", ts: new Date().toISOString() });
    try {
      const registration = readFileSync(meshFile(sharingSpace));
      const result = expectSuccess(["update", "--self", "--space", controllerSpace]);
      assert.match(result.stdout, /stopped; no manager running/);
      assert.deepEqual(readFileSync(meshFile(sharingSpace)), registration, "update preserves the other registration");
      assert.deepEqual(readFileSync(join(controllerProject, journalPath)), journalBefore, "update preserves the stopped controller journal");
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(address.port, "127.0.0.1", resolve); });
      try {
        const cwd = process.cwd();
        try {
          process.chdir(controllerProject);
          await assert.rejects(readManagerContinuity({ space: controllerSpace }), /another registration names this stack's exact broker address/);
        } finally { process.chdir(cwd); }
      } finally {
        await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      }
    } finally { removeMesh(sharingSpace); }
    for (const kind of ["copy", "move", "forgotten"] as const) {
      if (kind === "copy") {
        controllerProject = join(root, "controller-copy");
        cpSync(originalProject, controllerProject, { recursive: true });
      } else if (kind === "move") {
        controllerProject = join(root, "controller-moved");
        renameSync(originalProject, controllerProject);
      } else expectSuccess(["space", "forget", controllerSpace]);
      const cwd = process.cwd();
      try {
        process.chdir(controllerProject);
        assert.equal(await readManagerContinuity({}, { readOnly: true, retainGraph: true }), "none", `${kind}: staged pre-install skips the foreign-root controller journal`);
        await assert.rejects(readManagerContinuity({ creds: join(root, "missing.creds") }), `${kind}: explicit credentials still refuse`);
      } finally { process.chdir(cwd); }
      for (const args of [["update"], ["update", "--self"]]) {
        const result = expectSuccess(args);
        assert.match(result.stdout, /records and processes untouched, continuity not checked/);
        assert.ok(result.stdout.includes(controllerProject) && result.stdout.includes(originalProject), "skip names both roots");
        assert.doesNotMatch(result.stdout, /no manager running/, "foreign-root records do not prove custody is absent");
        assert.deepEqual(readFileSync(join(controllerProject, journalPath)), journalBefore, "update preserves the controller journal");
      }
    }
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      for (const temporary of [temp, "/usr"]) {
        for (const args of [["update", "--self"], ["update", "--self"], ["update"], ["update", "--check"], ["status"]]) expectSuccess(args, temporary);
      }
      assert.deepEqual(readdirSync(temp), [], "update never writes to the unwritable TMPDIR");
      assert.equal(statSync(temp).mode & 0o777, 0o500, "update does not chmod the caller's TMPDIR");
    }
  } finally {
    if (started) controllerCli(["down", "--yes"]);
    chmodSync(temp, 0o700);
  }
  console.log(`COTAL_SMOKE_SENTINEL cells=${counted.cells()} passed=${counted.cells()} failed=0`);
} finally {
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (prior === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prior;
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}
