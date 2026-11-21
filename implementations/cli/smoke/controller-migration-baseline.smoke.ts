/** Live baseline for controller migration custody. The public launcher creates the stack;
 * the four withheld routes must refuse without changing its authority or member identities.
 * Ordinary down/up retains real File messages and a durable ACK floor. Fixtures are retained. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, jetstream, jetstreamManager, StorageType } from "@nats-io/jetstream";
import { credsFromJwt, newIdentity } from "@cotal-ai/core";
import { acquireMaintenanceLock, getSpaceAuth, readMaintenanceJournal, readServiceExecution, releaseMaintenanceLock, serviceExecutionPath, serviceIdentityPath, workspaceSecretStore } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { readStackJournal } from "../src/lib/stack-journal.js";
import { observeServiceProcess, serviceInstanceStore, serviceInstances } from "../src/lib/service-instances.js";
import { observeControllerMigrationHost } from "../src/lib/controller-migration-host.js";
import { serviceDefinitionStore } from "../src/lib/service-definitions.js";

const executionBinding = process.argv.includes("--execution-binding");
const hostBinding = process.argv.includes("--host-binding") || executionBinding;
const { check, finish, passed, failed } = createSuite();
const option = (name: string) => { const at = process.argv.indexOf(name); if (at < 0) return undefined; const value = process.argv[at + 1]; assert.ok(value && !value.startsWith("--"), `${name} needs a value`); return resolve(value); };
const binary = option("--binary") ?? join(import.meta.dirname, "../../../bin/dist/cotal.js");
const generationFile = option("--generation");
const generation = generationFile ? JSON.parse(readFileSync(generationFile, "utf8")) as { root: string; inventorySha256: string } : undefined;
assert.ok(existsSync(binary), "build cotal-ai and its dependencies before the live baseline");
process.umask(0o077);
const fixture = mkdtempSync(join(tmpdir(), "controller-migration-baseline-"));
const home = join(fixture, "home"), root = join(fixture, "root"), shims = join(fixture, "bin");
for (const directory of [home, root, shims]) mkdirSync(directory, { mode: 0o700 });
const space = "custody-baseline", server = `nats://127.0.0.1:${await freePort()}`;
const env: NodeJS.ProcessEnv = {
  PATH: `${shims}:${process.env.PATH}`, HOME: home, USERPROFILE: home, LANG: "C.UTF-8", NO_COLOR: "1",
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"),
  XDG_RUNTIME_DIR: join(home, "run"), COTAL_HOME: join(home, ".cotal"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"), TMPDIR: join(fixture, "tmp"),
  COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off",
};
for (const key of ["XDG_RUNTIME_DIR", "TMPDIR"] as const) mkdirSync(env[key]!, { mode: 0o700 });
// Any native supervisor command is a fixture failure. No host unit is inspected or changed.
const supervisorCalls = join(fixture, "supervisor-calls");
for (const command of ["systemctl", "launchctl", "schtasks.exe"]) {
  writeFileSync(join(shims, command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${supervisorCalls}'\nexit 95\n`, { mode: 0o700 });
}
const anchor = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME!, xdgConfigHome: env.XDG_CONFIG_HOME! });
const originalEnv = { ...process.env };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
const run = (args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [binary, ...args], options);
  // Raw command output stays in the private fixture, never in a failure payload.
  const label = `${readdirSync(fixture).length}-${args[0]}`;
  writeFileSync(join(fixture, `${label}.stdout`), result.stdout ?? "", { mode: 0o600 });
  writeFileSync(join(fixture, `${label}.stderr`), result.stderr ?? "", { mode: 0o600 });
  let envelope: { outcome?: string; error?: { code?: string }; target?: { root?: string; space?: string } } | undefined;
  try { envelope = JSON.parse(result.stdout ?? ""); } catch { /* a failed launcher is reported by status */ }
  return { status: result.status, signal: result.signal, envelope, log: label };
};
const authority = () => {
  const hashes: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`, path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isFile()) hashes[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
      else throw new Error("fixture authority unexpectedly contains a non-file entry");
    }
  };
  walk(join(root, ".cotal", "auth"), "auth");
  for (const name of ["stack-controller.json", "nats-server.conf", "server.conf"]) {
    const path = join(root, ".cotal", name);
    if (existsSync(path)) hashes[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return hashes;
};
const members = () => serviceInstances(space).map(row => ({
  name: row.name, revision: row.record.revision, process: row.record.value.process,
  state: row.record.value.state, observed: observeServiceProcess(row.record.value),
}));
let nc: NatsConnection | undefined, started = false;
try {
  const created = run(["space", "create", space, "--root", root, "--json"]);
  assert.equal(created.status, 0, JSON.stringify(created));
  check("public space create prepares the isolated root", true);
  const up = run(["up", "--root", root, "--space", space, "--server", server, "--detach", "--json"]);
  started = true;
  assert.equal(up.status, 0, JSON.stringify(up));
  const stack = readStackJournal(root)!.journal;
  check("public up creates a completed controller stack with broker, delivery and manager", stack.operation.phase === "completed" &&
    stack.members.filter(row => row.instanceId !== null).map(row => row.role).join(",") === "broker,delivery,manager");
  check("each launcher-created member is actually running", members().length === 3 && members().every(row => row.observed === "running"));
  if (executionBinding) {
    for (const member of stack.members.filter(row => row.instanceId !== null)) {
      const instance = serviceInstances(space).find(row => row.name === member.instanceId)!.record.value;
      const context = { space, instanceId: instance.instanceId, launchRequestId: instance.launchRequestId, stateDirectory: serviceInstanceStore(space).directory()! };
      const path = serviceIdentityPath(context).replace(/\.identity\.json$/, ".execution.json");
      check(member.role === "broker" ? "the native broker does not claim a Cotal/Node execution identity" : `the actual ${member.role} child records its loaded execution source`, existsSync(path) === (member.role !== "broker"));
      if (member.role === "broker") continue;
      const source = readFileSync(path), record = readServiceExecution(context, instance.process!);
      assert.ok(record);
      check(`${member.role}: receipt binds the actual child rather than the test process`, record.process.pid === instance.process!.pid && record.process.pid !== process.pid);
      check(`${member.role}: receipt names the actual logical and loaded entries`, record.execution.logicalEntry === realpathSync.native(binary) && record.execution.loadedEntry === realpathSync.native(generation ? join(generation.root, "dist/cotal.js") : binary));
      const executable = statSync(`/proc/${instance.process!.pid}/exe`, { bigint: true });
      check(`${member.role}: Node observation matches the running kernel image`, record.node.path === realpathSync.native(process.execPath) && record.node.version === process.version && record.node.dev === String(executable.dev) && record.node.ino === String(executable.ino) && record.node.bytes === Number(executable.size));
      assert.deepEqual(readServiceExecution(context, instance.process!), record);
      check(`${member.role}: reads leave the private receipt bytes unchanged`, (lstatSync(path).mode & 0o777) === 0o600 && readFileSync(path).equals(source));
      check(`${member.role}: byte-proof is exactly the native generation or explicitly absent`, generation
        ? record.generationInventory?.path === join(dirname(generation.root), "inventory.json") && record.generationInventory.sha256 === generation.inventorySha256 && record.generationInventory.bytes === readFileSync(record.generationInventory.path).length
        : record.generationInventory === null);
      assert.throws(() => readServiceExecution(context, { ...instance.process!, token: String(BigInt(instance.process!.token) + 1n) }));
      check(`${member.role}: a different process birth cannot read this binding`, true);
      check(`${member.role}: missing launch evidence never borrows the current process identity`, readServiceExecution({ ...context, launchRequestId: randomUUID() }, instance.process!) === undefined);
      const directory = join(fixture, `receipt-faults-${member.role}`); mkdirSync(directory, { mode: 0o700 });
      const copiedContext = { ...context, stateDirectory: directory }, copy = serviceExecutionPath(copiedContext);
      writeFileSync(copy, source, { mode: 0o600 });
      assert.deepEqual(readServiceExecution(copiedContext, instance.process!), record);
      check(`${member.role}: copied native receipt is a valid closed-reader control`, true);
      writeFileSync(copy, JSON.stringify({ ...record, unexpected: true }));
      assert.throws(() => readServiceExecution(copiedContext, instance.process!));
      check(`${member.role}: unknown receipt fields refuse`, true);
      writeFileSync(copy, JSON.stringify({ ...record, launchRequestId: randomUUID() }));
      assert.throws(() => readServiceExecution(copiedContext, instance.process!));
      check(`${member.role}: another launch cannot be relabeled by its filename`, true);
    }
  }
  if (hostBinding) {
    const lock = acquireMaintenanceLock(root, { operation: "stream-migration" });
    try {
      const before = authority(), observed = observeControllerMigrationHost(lock);
      check("host binding names the launcher's root, operation and three full member identities", observed.root === root && observed.space === space && observed.stack.operationId === stack.operation.id &&
        observed.members.length === 3 && observed.members.every(row => stack.members.some(member => member.instanceId === row.instanceId)));
      const config = readFileSync(observed.brokerConfig.path);
      check("host binding pins the real launch configuration bytes", observed.brokerConfig.bytes === config.length && observed.brokerConfig.sha256 === createHash("sha256").update(config).digest("hex"));
      assert.deepEqual(observeControllerMigrationHost(lock), observed);
      check("a second unchanged observation retains all identity pins", true);
      assert.deepEqual(authority(), before);
      check("host observation writes no authority or stack journal", readMaintenanceJournal(root) === undefined);
      try {
        writeFileSync(observed.brokerConfig.path, Buffer.concat([config, Buffer.from("\n# changed fixture configuration\n")]), { mode: 0o600 });
        assert.throws(() => observeControllerMigrationHost(lock), /configuration differs/);
        check("changed configuration refuses even while the original broker still runs", true);
      } finally { writeFileSync(observed.brokerConfig.path, config, { mode: 0o600 }); }
      assert.deepEqual(observeControllerMigrationHost(lock), observed);
      check("restoring the fixture configuration recovers the original host binding", true);
    } finally { releaseMaintenanceLock(lock); }
    assert.throws(() => observeControllerMigrationHost(lock));
    check("an expired maintenance lock cannot observe migration custody", true);
  }
  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  assert.ok(auth?.account.signingSeed);
  const identity = newIdentity(), signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
  let creds: string;
  try {
    const jwt = await encodeUser("custody-baseline-reader", fromPublic(identity.id), fromPublic(auth.account.pub), {
      pub: { allow: ["$JS.API.INFO", "$JS.API.STREAM.CREATE.CUSTODY_BASELINE", "$JS.API.STREAM.INFO.CUSTODY_BASELINE", "$JS.API.STREAM.MSG.GET.CUSTODY_BASELINE",
        "$JS.API.CONSUMER.CREATE.CUSTODY_BASELINE.>", "$JS.API.CONSUMER.INFO.CUSTODY_BASELINE.keeper", "$JS.API.CONSUMER.MSG.NEXT.CUSTODY_BASELINE.keeper", "$JS.ACK.CUSTODY_BASELINE.>", "custody.baseline"] },
      sub: { allow: [`_INBOX_${identity.id}.>`] },
    }, { signer, exp: Math.floor(Date.now() / 1000) + 900 });
    creds = credsFromJwt(jwt, identity);
  } finally { signer.clear(); }
  const dial = () => connect({ servers: server, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${identity.id}`, reconnect: false, timeout: 3_000 });
  nc = await dial();
  let jsm = await jetstreamManager(nc), js = jetstream(nc);
  await jsm.streams.add({ name: "CUSTODY_BASELINE", subjects: ["custody.baseline"], storage: StorageType.File });
  await jsm.consumers.add("CUSTODY_BASELINE", { durable_name: "keeper", ack_policy: AckPolicy.Explicit });
  for (let i = 0; i < 3; i++) await js.publish("custody.baseline", new TextEncoder().encode(`retained-${i}`));
  const message = await (await js.consumers.get("CUSTODY_BASELINE", "keeper")).next({ expires: 1_000 });
  assert.ok(message && await message.ackAck());
  const beforeStream = await jsm.streams.info("CUSTODY_BASELINE"), beforeDurable = await jsm.consumers.info("CUSTODY_BASELINE", "keeper");
  const rows = async () => Promise.all([1, 2, 3].map(async seq => (await nc!.request("$JS.API.STREAM.MSG.GET.CUSTODY_BASELINE", JSON.stringify({ seq }))).json()));
  const beforeRows = await rows();
  check("native control holds three File messages and ACK floor one", beforeStream.state.messages === 3 && beforeDurable.ack_floor.stream_seq === 1);
  const artifact = join(fixture, "artifact");
  const withheld = (stage: string) => {
    const beforeAuthority = authority(), beforeMembers = members();
    for (const args of [["down", "--preserve-state", "--yes"], ["backup", "create", artifact], ["backup", "restore", artifact], ["up", "--restore", artifact]]) {
      const result = run([...args, "--json"]);
      check(`${stage}: ${args.slice(0, 2).join(" ")} refuses UNSUPPORTED`, result.status === 2 && result.envelope?.outcome === "refused" && result.envelope.error?.code === "UNSUPPORTED" && result.envelope.target?.root === root && result.envelope.target?.space === space, result);
    }
    assert.deepEqual(authority(), beforeAuthority); check(`${stage}: authority and controller journal bytes are unchanged`, true);
    assert.deepEqual(members(), beforeMembers); check(`${stage}: member records and process states are unchanged`, true);
    check(`${stage}: no maintenance cut or backup artifact was created`, readMaintenanceJournal(root) === undefined && !existsSync(artifact));
  };
  withheld("running");
  await nc.close(); nc = undefined;
  const down = run(["down", "--space", space, "--yes", "--json"]);
  assert.equal(down.status, 0, JSON.stringify(down));
  check("ordinary down succeeds through native controller ownership", true);
  check("ordinary down leaves every recorded member proven gone", members().length === 3 && members().every(row => ["gone", "previous-boot", "foreign-pid"].includes(row.observed)));
  withheld("stopped");
  if (hostBinding) {
    const lock = acquireMaintenanceLock(root, { operation: "stream-migration" });
    try { assert.throws(() => observeControllerMigrationHost(lock), /settled running stack/); check("an ordinarily stopped stack is not a pre-stop migration binding", true); }
    finally { releaseMaintenanceLock(lock); }
  }
  const restart = run(["up", "--root", root, "--space", space, "--server", server, "--detach", "--json"]);
  assert.equal(restart.status, 0, JSON.stringify(restart));
  check("ordinary up restarts the same controller root", readStackJournal(root)?.journal.root === root);
  nc = await dial(); jsm = await jetstreamManager(nc); js = jetstream(nc);
  const afterStream = await jsm.streams.info("CUSTODY_BASELINE"), afterDurable = await jsm.consumers.info("CUSTODY_BASELINE", "keeper");
  assert.deepEqual(afterStream.config, beforeStream.config);
  check("ordinary restart keeps the File stream identity and message count", afterStream.created === beforeStream.created && afterStream.state.messages === 3);
  assert.deepEqual(await rows(), beforeRows); check("ordinary restart keeps message sequence, timestamp and payload bytes", true);
  assert.deepEqual(afterDurable.config, beforeDurable.config);
  check("ordinary restart keeps the durable ACK floor and pending count", afterDurable.ack_floor.stream_seq === 1 && afterDurable.num_pending === 2 && afterDurable.num_ack_pending === 0);
  const next = await (await js.consumers.get("CUSTODY_BASELINE", "keeper")).next({ expires: 1_000 });
  check("the restarted durable delivers the next retained message", next?.info.streamSequence === 2 && next.string() === "retained-1" && await next.ackAck());
  if (hostBinding) {
    const store = serviceDefinitionStore(space);
    store.commit("outside-custody", undefined, { schemaVersion: 1, space, root,
      launch: { type: "process", executable: process.execPath, args: [], cwd: root }, readiness: { type: "process", timeoutMs: 1_000 } });
    const lock = acquireMaintenanceLock(root, { operation: "stream-migration" });
    try { assert.throws(() => observeControllerMigrationHost(lock), /additional service definitions/); check("an additional unstarted service definition cannot be silently omitted", true); }
    finally { releaseMaintenanceLock(lock); }
  }
  check("no native OS supervisor command was invoked", !existsSync(supervisorCalls));
} catch (error) {
  check(`harness: ${error instanceof Error ? error.message : String(error)}`, false);
} finally {
  await nc?.close();
  if (started) {
    const down = run(["down", "--space", space, "--yes", "--json"]);
    check("final native down exits successfully", down.status === 0, down);
    check("no fixture service process remains running or unknown", members().every(row => ["gone", "previous-boot", "foreign-pid"].includes(row.observed)));
  }
  console.log(`retained owned fixture: ${fixture}`);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  const expected = executionBinding ? 60 : hostBinding ? 37 : 28;
  if (passed() + failed() !== expected) check(`cell count: ran ${passed() + failed()}, expected ${expected}`, false);
  finish();
}
process.exitCode = failed() ? 1 : 0;
