/** Updates skip retained legacy configurations without claiming continuity and prove stopped controllers cold. */
import "./update-isolation.js";
import nodeAssert from "node:assert/strict";
import { assertSmokeSandboxDown, countedAssert, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSpaceAuth } from "@cotal-ai/core";
import type { MeshTarget } from "@cotal-ai/workspace";
import { isStoppedLocalMesh, readManagerContinuity } from "../src/commands/update.js";
import { assertRecordIdentity, authDir, clearCurrent, clearUpdateRecovery, findPreparedSpace, localProcessPath, MANAGER_PIDFILE, meshFile, parsePid, readCurrent, recordMesh, recordPreparedSpace, removeMesh, saveSpaceAuth, setCurrent, spaceKey, writeUpdateRecovery } from "@cotal-ai/workspace";
import { writeStackJournal, STACK_ROLES, type StackJournal } from "../src/lib/stack-journal.js";
import { serviceInstances, serviceInstanceStore, processServiceHost, requireProcessIdentity } from "../src/lib/service-instances.js";
import { SEED_BUILTINS } from "../src/seed/paths.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

function checkForeignLaunch(bin: string, cwd: string, space: string, version: string, env: NodeJS.ProcessEnv & { XDG_CONFIG_HOME: string }): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const scratch = realpathSync.native(mkdtempSync(join(cwd, "foreign-launch-")));
  const base = join(env.XDG_CONFIG_HOME, "cotal");
  const target = "9.8.7", id = "a".repeat(32);
  const metadata = { name: "cotal-ai", type: "module", version, bin: { cotal: "./dist/cotal.js" } };
  function prefix(name: string) {
    const lib = join(scratch, name, "lib"), installed = join(lib, "node_modules/cotal-ai"), entry = join(installed, "dist/cotal.js");
    mkdirSync(installed, { recursive: true, mode: 0o700 });
    writeFileSync(join(installed, "package.json"), JSON.stringify(metadata));
    cpSync(dirname(bin), dirname(entry), { recursive: true });
    symlinkSync(resolve(bin, "../../node_modules"), join(installed, "node_modules"), "dir");
    const key = createHash("sha256").update(entry).digest("hex");
    const set = join(base, "installs", key, "sets", version), config = join(set, "cotal");
    const seed = join(config, "seed");
    mkdirSync(seed, { recursive: true, mode: 0o700 });
    writeFileSync(join(set, "selection.json"), JSON.stringify({ v: 1, entry, version, root: config }), { mode: 0o600 });
    writeFileSync(join(seed, "authority.json"), JSON.stringify({ everSeeded: SEED_BUILTINS }), { mode: 0o600 });
    writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }), { mode: 0o600 });
    writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }), { mode: 0o600 });
    const store = join(lib, ".cotal-generations"), execution = join(store, ".transaction-smoke", "execution.json");
    const snapshot = join(config, ".update-snapshot-smoke");
    mkdirSync(dirname(execution), { recursive: true, mode: 0o700 });
    mkdirSync(snapshot, { mode: 0o700 });
    writeFileSync(execution, JSON.stringify({ v: 1, installed, previous: { manifest: JSON.stringify(metadata), bootstrap: "", descriptor: null },
      target: { id, version: target, root: join(store, id, "cotal-ai"), inventorySha256: "a".repeat(64) } }), { mode: 0o600 });
    return { entry, execution, snapshot };
  }
  const a = prefix("a"), b = prefix("b");
  const launch = (entry: string) => spawnSync(process.execPath, [entry, "spawn", "default", "--space", space, "--detach", "--plain"], {
    cwd, env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "0" }, encoding: "utf8", timeout: 45_000,
  });
  const noRecovery = /an interrupted update needs restoration/;
  const abandoned = { previous: version, installed: version, target, phase: "replacing" as const, reason: "interrupted update",
    owner: { pid: 2147483647, start: "dead-start", nonce: "old-owner" }, execution: b.execution, snapshot: b.snapshot };
  const refuse = (entry: string, record: typeof abandoned, label: string) => {
    writeUpdateRecovery(record);
    const result = launch(entry);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, `${label}: ${output}`);
    assert.match(output, noRecovery, label);
    assert.doesNotMatch(output, /Managed launch/, label);
  };
  try {
    writeUpdateRecovery(abandoned);
    const recovery = join(env.COTAL_HOME!, "update-recovery.json"), before = readFileSync(recovery);
    const allowed = launch(a.entry), output = allowed.stdout + allowed.stderr;
    assert.match(output, /Managed launch/, output);
    assert.match(output, /not found|unavailable|Original request|Agent started/i, output);
    assert.doesNotMatch(output, noRecovery);
    assert.deepEqual(readFileSync(recovery), before, "dispatch leaves the foreign record unchanged");
    refuse(b.entry, abandoned, "the owning installation still blocks");
    refuse(a.entry, { ...abandoned, execution: join(scratch, "absent") }, "missing journal blocks");
    refuse(a.entry, { ...abandoned, snapshot: a.snapshot }, "disagreeing owners block");
    refuse(a.entry, { ...abandoned, snapshot: join(base, ".update-snapshot-legacy") }, "unscoped snapshot blocks");
  } finally { clearUpdateRecovery(); }
}

function offlineUpdateFixture(bin: string, cwd: string, version: string, env: NodeJS.ProcessEnv) {
  const scratch = mkdtempSync(join(cwd, "inaccessible-update-"));
  const config = join(scratch, "config"), seed = join(config, "cotal", "seed");
  mkdirSync(seed, { recursive: true, mode: 0o700 });
  // Honor previously removed built-ins without attempting any package installation.
  writeFileSync(join(seed, "authority.json"), JSON.stringify({ everSeeded: SEED_BUILTINS }), { mode: 0o600 });
  writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }), { mode: 0o600 });
  const stamp = join(seed, "stamp.json");
  writeFileSync(stamp, JSON.stringify({ generation: version }), { mode: 0o600 });
  const npm = join(scratch, "npm"), unexpected = join(scratch, "unexpected-npm-call");
  writeFileSync(npm, `#!/bin/sh
case "$1 $2" in
  "view cotal-ai@latest") printf '"%s"\\n' "$SMOKE_CLI_VERSION" ;;
  "--version ") printf '11.0.0\\n' ;;
  *) printf '%s\\n' "$*" >> "$SMOKE_UNEXPECTED_NPM"; exit 97 ;;
esac
`, { mode: 0o700 });
  const run = (args: string[], extra?: NodeJS.ProcessEnv) => spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: "utf8", timeout: 120_000,
    env: { ...env, XDG_CONFIG_HOME: config, PATH: `${scratch}:${env.PATH}`, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      SMOKE_CLI_VERSION: version, SMOKE_UNEXPECTED_NPM: unexpected, ...extra },
  });
  return { run, config, stamp, unexpected };
}

function checkInaccessibleUpdate(bin: string, cwd: string, project: string, space: string, version: string, env: NodeJS.ProcessEnv & { COTAL_HOME: string }): void {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const { run, unexpected } = offlineUpdateFixture(bin, cwd, version, env);
  const records = [meshFile(space), join(project, ".cotal", "stack-controller.json")];
  const definitions = join(env.COTAL_HOME, "services", spaceKey(space), "definitions");
  const instances = join(env.COTAL_HOME, "services", spaceKey(space), "instances");
  for (const dir of [definitions, instances]) records.push(...readdirSync(dir).filter(name => name.endsWith(".json")).map(name => join(dir, name)));
  const before = records.map(path => readFileSync(path));
  const attempts = [project, join(project, ".cotal")].flatMap(blocked => {
    const mode = statSync(blocked).mode & 0o777;
    try {
      chmodSync(blocked, 0o000);
      assert.throws(() => statSync(join(blocked, blocked === project ? ".cotal" : "stack-controller.json")), { code: "EACCES" });
      return [[], ["--space", space]].map(flags => ({ blocked, result: run(["update", ...flags]) }));
    } finally { chmodSync(blocked, mode); }
  });
  assert.deepEqual(attempts.map(({ result }) => result.status), [0, 0, 0, 0], attempts.map(({ blocked, result }) => `${blocked}:\n${result.stdout}${result.stderr}`).join("\n"));
  for (const { result } of attempts) {
    assert.ok(result.stdout.includes(`${space}: folder is gone; leaving its processes untouched, continuity not checked`));
    assert.ok(result.stdout.includes(`Registry latest: ${version}`), "the private npm stub answered the version lookup");
    assert.doesNotMatch(result.stderr, /running manager continuity check/);
  }
  assert.equal(existsSync(unexpected), false, "update never requests an npm install or unrelated registry lookup");
  assert.deepEqual(records.map(path => readFileSync(path)), before, "update leaves registration, journal, definitions and instance records byte-identical");
}

function checkDeniedManagerUpdate(bin: string, cwd: string, project: string, space: string, version: string,
  env: NodeJS.ProcessEnv, layout: "legacy" | "static"): void {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const { run, config, stamp, unexpected } = offlineUpdateFixture(bin, cwd, version, env);
  const dot = join(project, ".cotal"), journal = join(dot, "stack-controller.json");
  assert.equal(existsSync(journal), layout === "static", "the live stack uses the expected layout");
  const pid = layout === "static"
    ? serviceInstances(space, "stack-manager").find(row => row.record.value.state === "running")?.record.value.process?.pid
    : parsePid(readFileSync(localProcessPath(MANAGER_PIDFILE, { root: project, space }), "utf8"));
  assert.ok(pid, "a real Manager is running behind the denied path");
  const manager = requireProcessIdentity(pid);
  const auth = authDir(project), serverConf = join(auth, "server.conf");
  const snapshot = () => readdirSync(config, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name)).sort().map(path => [path, readFileSync(path)]);
  const paths = layout === "legacy" ? [[project, dot], [dot, join(dot, "stack-home.json")]] : [[auth, serverConf]];
  for (const [blocked, probe] of paths) {
    const mode = statSync(blocked).mode & 0o777;
    writeFileSync(stamp, JSON.stringify({ generation: version }));
    const current = snapshot();
    try {
      chmodSync(blocked, 0o000);
      assert.throws(() => statSync(probe), { code: "EACCES" });
      if (layout === "static") assert.ok(statSync(journal).isFile(), "the journal is still visible when only auth is denied");
      const detail = layout === "legacy" ? `${dot}: directory could not be listed` : `cannot inspect ${join(auth, `manager-instance.${spaceKey(space)}.json`)}`;
      for (const flags of [[], ["--space", space]]) {
        const result = run(["update", ...flags]);
        const output = result.stdout + result.stderr;
        assert.equal(result.status, 1, output);
        assert.ok(result.stderr.includes(`running manager continuity check: local Manager continuity cannot be established: ${detail}`), output);
        assert.doesNotMatch(output, /continuity not checked|connectors reconciled|connector integrations refreshed/);
        assert.deepEqual(snapshot(), current, "a refused update leaves the connector configuration and seed bytes unchanged");
      }
      writeFileSync(stamp, JSON.stringify({ generation: "0.0.1" }));
      const before = snapshot();
      const seed = run(["send", "--space", space, "-c", "general", "seed hold probe"], { COTAL_SKIP_CONNECTOR_SEED: "0" });
      const output = seed.stdout + seed.stderr;
      assert.ok(seed.stderr.includes(`${detail}; its connectors stay at their existing version until the Manager is restarted`), output);
      assert.doesNotMatch(output, /migrated operator-global seed store/);
      assert.deepEqual(snapshot(), before, "automatic seed leaves the previous generation and connector records unchanged");
    } finally { chmodSync(blocked, mode); }
    assert.equal(assertRecordIdentity(manager).kind, "match", "the same running Manager survives update and automatic seed");
  }
  assert.equal(existsSync(unexpected), false, "no npm install or unrelated registry lookup was requested");
}

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
let registry: ChildProcess | undefined;
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
  // Keep self-update on the built version even when a new release reaches npm.
  const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../bin/package.json"), "utf8"));
  registry = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "node:http";
    const version = process.argv[1];
    const packument = JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } });
    const server = createServer((request, reply) => request.url === "/cotal-ai"
      ? reply.writeHead(200, { "content-type": "application/json" }).end(packument)
      : reply.writeHead(404).end());
    server.listen(0, "127.0.0.1", () => process.send(server.address()));
    process.on("disconnect", () => server.close());
  `, version], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const registryAddress = await new Promise<AddressInfo>((done, reject) => {
    registry!.once("message", address => done(address as AddressInfo));
    registry!.once("error", reject);
    registry!.once("exit", code => reject(new Error(`smoke registry exited ${code}`)));
  });
  const registryUrl = `http://127.0.0.1:${registryAddress.port}`;
  const tools = join(other, "tools");
  mkdirSync(tools, { mode: 0o700 });
  if (process.platform === "win32") {
    writeFileSync(join(tools, "npm.cmd"), `@echo off\r\nset "PATH=%SMOKE_NPM_PATH%"\r\nif "%~1 %~2"=="view cotal-ai@latest" (npm %* --registry ${registryUrl} --noproxy 127.0.0.1) else (npm %*)\r\n`);
  } else {
    writeFileSync(join(tools, "npm"), `#!/bin/sh\nexport PATH="$SMOKE_NPM_PATH"\nif [ "$1 $2" = "view cotal-ai@latest" ]; then\n  set -- "$@" --registry ${registryUrl} --noproxy 127.0.0.1\nfi\nexec npm "$@"\n`, { mode: 0o700 });
  }
  const registryEnv = { PATH: `${tools}${process.platform === "win32" ? ";" : ":"}${ambient.PATH}`, SMOKE_NPM_PATH: ambient.PATH };
  const home = join(other, "home");
  mkdirSync(home, { mode: 0o700 });
  const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], {
    cwd: other, env: { ...ambient, ...registryEnv, HOME: home, USERPROFILE: home, COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(home, ".config"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1" },
    encoding: "utf8", timeout: 120_000,
  });
  const deleted = join(other, "project"), space = `deleted-${randomUUID()}`;
  mkdirSync(deleted, { mode: 0o700 });
  assert.equal(cli("space", "create", space, "--root", deleted).status, 0, "the CLI prepares the project");
  assert.equal(cli("use", space).status, 0, "the CLI selects the prepared project");
  const prepared = findPreparedSpace(space);
  if (process.getuid && process.getuid() !== 0) {
    const record = join(process.env.COTAL_HOME!, "prepared", `space.${Buffer.from(space).toString("hex")}.json`);
    const before = readFileSync(record, "utf8");
    chmodSync(record, 0o000);
    try {
      assert.throws(() => readFileSync(record), { code: "EACCES" });
      const update = cli("update", "--self");
      const output = update.stdout + update.stderr;
      assert.equal(update.status, 0, output);
      assert.match(update.stdout, /leaving its records and processes untouched, continuity not checked/);
      assert.match(update.stderr, /could not be read \(EACCES/);
      assert.ok(output.includes(record) && !output.includes("cotal space forget"), output);
      assert.equal(statSync(record).mode & 0o777, 0o000, "self-update leaves the record's mode unchanged");
    } finally { chmodSync(record, 0o600); }
    assert.equal(readFileSync(record, "utf8"), before, "self-update leaves the prepared record unchanged");
  }
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
  const pointer = join(process.env.COTAL_HOME!, "current-mesh"), marker = `${pointer}.adopted`;
  const noSelection = cli("update");
  assert.equal(noSelection.status, 0, noSelection.stdout + noSelection.stderr);
  for (const damage of ["empty pointer", "unreadable marker"]) {
    const saved = damage === "empty pointer" ? "" : space;
    writeFileSync(pointer, saved, { mode: 0o600 });
    if (damage === "unreadable marker") mkdirSync(marker);
    try {
      const update = cli("update");
      assert.equal(update.status, noSelection.status, `${damage}: ${update.stdout}\n${update.stderr}`);
      assert.match(update.stdout, /Built-in connectors/);
      assert.match(update.stdout, /Registry latest:/);
      assert.doesNotMatch(update.stderr, /running manager continuity check|current-mesh/);
      assert.equal(readFileSync(pointer, "utf8"), saved, "update keeps the selection bytes");
      if (damage === "unreadable marker") assert.ok(statSync(marker).isDirectory(), "update keeps the damaged marker");
    } finally {
      if (damage === "unreadable marker") rmdirSync(marker);
      clearCurrent();
    }
  }
  const privateHome = join(root, "private-home");
  mkdirSync(privateHome, { mode: 0o700 });
  const env = { ...ambient, ...registryEnv, HOME: privateHome, COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
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
        cwd: project, encoding: "utf8", timeout: 120_000, env,
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
  const stoppedSandbox = recordSmokeSandbox({ root: stoppedProject, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  const stoppedCli = (...args: string[]) => {
    const options = { cwd: stoppedProject, encoding: "utf8" as const, timeout: 120_000, env };
    assertSmokeSandboxDown(stoppedSandbox, args, options);
    return spawnSync(process.execPath, [bin, ...args], options);
  };
  let started = false;
  try {
    const up = stoppedCli("up", "--detach", "--server", target.server, "--space", stoppedSpace);
    started = up.status === 0;
    assert.equal(up.status, 0, `explicit-space project starts\n${up.stdout}\n${up.stderr}`);
    checkDeniedManagerUpdate(bin, other, stoppedProject, stoppedSpace, version, env, "legacy");
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
  mkdirSync(originalProject, { mode: 0o700 });
  const controllerSandbox = recordSmokeSandbox({ root: originalProject, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  mkdirSync(temp, { mode: 0o500 });
  const controllerCli = (args: string[], temporary?: string, seed = false) => {
    const options = {
      cwd: controllerProject, encoding: "utf8" as const, timeout: 180_000,
      env: { ...env, ...(seed ? { COTAL_SKIP_CONNECTOR_SEED: "0" } : {}), ...(temporary ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary } : {}) },
    };
    assertSmokeSandboxDown(controllerSandbox, args, options);
    return spawnSync(process.execPath, [bin, ...args], options);
  };
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
    checkInaccessibleUpdate(bin, other, controllerProject, controllerSpace, version, env);
    checkDeniedManagerUpdate(bin, other, controllerProject, controllerSpace, version, env, "static");
    checkForeignLaunch(bin, controllerProject, controllerSpace, version, env);
    expectSuccess(["send", "-c", "general", "broker still running after update"]);
    expectSuccess(["down", "--yes"]);
    started = false;
    if (process.platform === "win32") {
      const { supervisorMayServe } = await import("../src/lib/manager-proc.js");
      const entry = join(controllerProject, "installed path", "dist", "cotal.js");
      mkdirSync(resolve(entry, ".."), { recursive: true });
      writeFileSync(entry, "setInterval(() => {}, 1000);\n");
      const supervisor = spawn(process.execPath, [entry, "supervise", "--space", controllerSpace], { stdio: "ignore" });
      try {
        await once(supervisor, "spawn");
        assert.equal(supervisorMayServe(controllerSpace, entry), true, "Windows sees a matching supervisor with a spaced entry path");
        assert.equal(supervisorMayServe(`${controllerSpace}-other`, entry), false, "Windows excludes a supervisor that names a different space");
      } finally {
        const stopped = once(supervisor, "close");
        supervisor.kill();
        await stopped;
      }
      assert.equal(supervisorMayServe(controllerSpace, entry), false, "Windows no longer sees the stopped supervisor");
      assert.match(expectSuccess(["update"]).stdout, /stopped; no manager running/);
    }
    expectSuccess(["use", "--clear"]);
    const journalPath = join(".cotal", "stack-controller.json");
    let journalBefore = readFileSync(join(controllerProject, journalPath));
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
    // Recreate the on-disk recovery state after an updater with no usable snapshot exits.
    writeUpdateRecovery({ previous: "0.171.0", target: "0.171.2", installed: "0.171.2", phase: "replacing", reason: "interrupted update",
      owner: { pid: 2147483647, start: "dead-start", nonce: "old-owner" } });
    const blocked = controllerCli(["up"], undefined, true);
    started = blocked.status === 0;
    assert.equal(blocked.status, 5, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout + blocked.stderr, /started no member.*an interrupted update needs restoration/);
    const failedJournal = readFileSync(join(controllerProject, journalPath));
    const recovered = expectSuccess(["update", "--self"]);
    assert.match(recovered.stdout, /Retained unusable interrupted-update records/);
    assert.match(recovered.stdout, /stopped; no manager running/);
    assert.deepEqual(readFileSync(join(controllerProject, journalPath)), failedJournal, "recovery does not start the controller or rewrite its journal");
    const restarted = controllerCli(["up"], undefined, true);
    started = restarted.status === 0;
    assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
    expectSuccess(["down", "--yes"]);
    started = false;
    journalBefore = readFileSync(join(controllerProject, journalPath));
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
  registry?.kill();
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (prior === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prior;
  rmSync(root, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}
