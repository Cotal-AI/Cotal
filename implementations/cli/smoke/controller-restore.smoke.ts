// Controller restore rollback and the stack fence. `rollbackRestoreWithBroker` moves a recorded
// broker definition rewrite back before the store rollback, attributes a live revision only when
// its options name the journaled config path and that file still hashes to the journaled digest,
// and holds with nothing overwritten otherwise. `stackMaintenanceFence` admits only a
// settled active controller restore of the same stack. A manager launch carries that
// stack's facts, and team boot and preserve still refuse the restored stack with their reasons. A
// broker or manager restart whose start would be refused refuses before any stop. A preserve
// refuses another live service instance in the space or a shared broker address before any effect,
// on a first preserve and on a retry of a committed cut.
// Saved records live under a sandboxed COTAL_HOME; no broker, child process or native effect is
// started.
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { brokerJetStreamBlock, type ParsedArgs } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import {
  acquireMaintenanceLock, beginMaintenanceCut, bindRestoreListener, bindRestoreTarget, completeMaintenanceCut, cutController, isCommandFailure,
  markRestoreActive, moveSamePathRestoreSource, prepareAlternateRestore, prepareSamePathRestore, readMaintenanceJournal, readPreservationPrepareIntent, recordMesh, recordPreservationManagerCommit,
  recordRestoreManagerCommit, recordRestoreReconfiguration, releaseMaintenanceLock, requestControllerMemberStart, serviceMetadataDigest,
  settleControllerMemberStart, writeMaintenanceResumeDocument, writeRestoreCommitIntent,
  type ControllerReconfiguration, type ControllerStop, type MaintenanceLock, type RestoreListenerProof,
} from "@cotal-ai/workspace";
import { serviceAction } from "../src/commands/service-actions.js";
import "../src/lib/broker-service.js";
import { preserveControllerStack } from "../src/lib/controller-preserve.js";
import { rollbackRestoreWithBroker } from "../src/lib/controller-restore.js";
import { resolveServiceAdapter } from "../src/lib/service-adapters.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "../src/lib/service-definitions.js";
import { processServiceHost, requireProcessIdentity, serviceInstanceStore } from "../src/lib/service-instances.js";
import { assertRestartAdmitted } from "../src/lib/service-process.js";
import { admittedStackRestore, maintenanceStackView, readStackJournal, stackMaintenanceFence, writeStackJournal, type StackJournal } from "../src/lib/stack-journal.js";
import { stackResumeEligibility } from "../src/lib/stack-resume.js";

let passed = 0;
async function check(name: string, condition: unknown): Promise<void> {
  assert.ok(await condition, name);
  passed++;
  console.log(`  ok ${name}`);
}

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-controller-restore-")));
const previousHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = join(sandbox, "home");
const server = "nats://127.0.0.1:4222";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const coordinator = { pid: process.pid, host: hostname(), startedAt: new Date(0).toISOString(), id: "coordinator" };

type Fixture = { root: string; store: string; space: string; lock: MaintenanceLock; fromConfig: string; toConfig: string; reconfiguration: ControllerReconfiguration };

/** A ready controller cut over a saved nats-broker definition. */
function readyCut(name: string) {
  const root = join(sandbox, name), store = join(root, "store"), control = join(root, ".cotal");
  mkdirSync(store, { recursive: true });
  mkdirSync(control, { recursive: true });
  const space = `space-${name}`;
  const fromConfig = join(control, "server.conf");
  const fromText = `listen: 127.0.0.1:4222\n${brokerJetStreamBlock(store)}\n`;
  writeFileSync(fromConfig, fromText, { mode: 0o600 });
  const options = { root, config: fromConfig, binary: process.execPath, server };
  const saved = serviceDefinitionStore(space).commit("stack-broker", undefined, { schemaVersion: 1, space, launch: { type: "adapter", adapter: "nats-broker", options }, readiness: { type: "adapter", timeoutMs: 30000 } })!;
  const member = (role: "broker" | "manager", revision: string) => ({ role, definition: `stack-${role}`, definitionRevision: revision, instanceId: randomUUID(), launchRequestId: randomUUID(), process: { pid: 7, token: `token-${role}` } });
  const binding = { stackOperationId: randomUUID(), brokerDefinitionRevision: saved.revision, members: [member("broker", saved.revision), member("manager", "rev-manager")], manager: { instanceId: "manager-instance", epoch: 1, lifecycleUid: "manager-uid" } };
  const lock = acquireMaintenanceLock(root);
  const resume = writeMaintenanceResumeDocument(lock, { version: 1, inventory: { agents: [] }, launch: { runtime: "pty" } });
  const cutId = `cut-${name}`;
  beginMaintenanceCut(lock, { attemptId: cutId, space, mode: "auth", sourcePath: store, resume, launch: { server, custody: "controller", controller: binding as never } });
  recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId: cutId, state: "preserved" });
  const observedAt = new Date().toISOString();
  completeMaintenanceCut(lock, {
    attemptId: cutId, observedAt, managerCommit: { operation: "commitPreservation", attemptId: cutId, state: "preserved" },
    stopped: { manager: true, broker: true, localProcesses: true }, listener: { endpoint: server, unreachable: true },
    controllerStops: binding.members.map((row) => ({ role: row.role, instanceId: row.instanceId, launchRequestId: row.launchRequestId,
      receipt: row.role === "manager" ? { kind: "preserved-exit", requestId: randomUUID(), scopeSha256: "a".repeat(64), observedAt } : { kind: "kernel-exit", requestId: randomUUID(), scopeSha256: "b".repeat(64), observedAt } }) as ControllerStop),
  });
  return { root, store, control, space, lock, binding, fromConfig, fromText, options, saved };
}

/** A controller alternate restore at `rendered`, over a saved nats-broker definition. */
function rendered(name: string): Fixture {
  const { root, store, control, space, lock, fromConfig, fromText, options, saved } = readyCut(name);
  const target = join(root, "target");
  const attemptId = `restore-${randomUUID()}`;
  prepareAlternateRestore(lock, { attemptId, targetPath: target, claim: { deadline: new Date(Date.now() + 60_000).toISOString(), coordinator } });
  mkdirSync(target);
  const bound = bindRestoreTarget(lock);
  const toConfig = join(control, `server.restore-${attemptId}.conf`);
  const toText = fromText.replace(brokerJetStreamBlock(store), brokerJetStreamBlock(target));
  writeFileSync(toConfig, toText, { mode: 0o600 });
  const stat = lstatSync(toConfig, { bigint: true });
  const reconfiguration: ControllerReconfiguration = {
    fromRevision: saved.revision, fromOptionsSha256: serviceMetadataDigest(options), fromConfigPath: fromConfig, fromConfigSha256: sha(fromText),
    toConfigPath: toConfig, toConfigSha256: sha(toText), toStoreIdentity: bound.restore.target!, phase: "rendered",
  };
  recordRestoreReconfiguration(lock, reconfiguration, { label: "config", path: toConfig, dev: stat.dev.toString(), ino: stat.ino.toString() });
  return { root, store, space, lock, fromConfig, toConfig, reconfiguration };
}

/** A same-path controller restore made active, then stopped by a stack down that settled it. The
 *  maintenance lock is released, as it is between commands. */
function activeRestore(name: string): { root: string; space: string; attemptId: string; stack: StackJournal } {
  const { root, store, space, lock, binding } = readyCut(name);
  const [broker, manager] = binding.members;
  const attemptId = `restore-${randomUUID()}`;
  prepareSamePathRestore(lock, { attemptId, targetPath: store, fallbackPath: join(root, `.cotal-restore-fallback-${attemptId}`), claim: { deadline: new Date(Date.now() + 60_000).toISOString(), coordinator } });
  moveSamePathRestoreSource(lock);
  mkdirSync(store);
  const bound = bindRestoreTarget(lock);
  writeRestoreCommitIntent(lock, { server, runtime: "pty", serverName: "n", serverNonce: "n", custody: "controller", controller: { stackOperationId: randomUUID(), started: [] } } as never);
  const brokerLaunch = randomUUID(), managerLaunch = randomUUID();
  requestControllerMemberStart(lock, { role: "broker", instanceId: broker!.instanceId, priorLaunchRequestId: broker!.launchRequestId });
  settleControllerMemberStart(lock, "broker", brokerLaunch, "running");
  const proof: RestoreListenerProof = {
    kind: "controller", attemptId, serverName: `${attemptId}-n`, serverNonce: "n",
    processOwner: { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id: `controller-broker-${brokerLaunch}` },
    serverEndpoint: server, target: bound.restore.target!,
    instance: { instanceId: broker!.instanceId, launchRequestId: brokerLaunch, process: { pid: process.pid, token: "token-live" } },
  };
  bindRestoreListener(lock, proof, { controllerInstanceRunning: () => true });
  requestControllerMemberStart(lock, { role: "manager", instanceId: manager!.instanceId, priorLaunchRequestId: manager!.launchRequestId });
  settleControllerMemberStart(lock, "manager", managerLaunch, "running");
  recordRestoreManagerCommit(lock, proof, { attemptId, state: "awaitingFinalize", durableCommitToken: "9".repeat(64) });
  markRestoreActive(lock, proof, { attemptId, state: "active", durableCommitToken: "9".repeat(64) });
  releaseMaintenanceLock(lock);
  const now = new Date().toISOString();
  const stack: StackJournal = {
    schemaVersion: 1, kind: "cotal-stack-controller", root, space, server, mode: "auth", broker: { storeDir: store },
    members: [
      { role: "broker", definition: "stack-broker", instanceId: broker!.instanceId, state: "stopped" },
      { role: "auth", definition: "stack-auth", instanceId: null, state: "not-attempted" },
      { role: "delivery", definition: "stack-delivery", instanceId: null, state: "not-attempted" },
      { role: "manager", definition: "stack-manager", instanceId: manager!.instanceId, state: "stopped" },
    ],
    operation: { id: randomUUID(), kind: "down", phase: "completed", recordedAt: now, withAgents: false }, updatedAt: now,
  };
  writeStackJournal(root, undefined, stack);
  return { root, space, attemptId, stack };
}

/** Rewrite the live definition's `config`, as the forward or a foreign write would. */
function rewrite(f: Fixture, config: string): string {
  const live = serviceDefinitionStore(f.space).read("stack-broker")!;
  const launch = live.record.value.launch as { type: "adapter"; adapter: string; options: Record<string, string> };
  return serviceDefinitionStore(f.space).commit("stack-broker", live, { ...live.record.value, launch: { ...launch, options: { ...launch.options, config } } } as typeof live.record.value)!.revision;
}

/** The live definition's `config` option, or undefined when it no longer launches an adapter. */
const liveConfig = (f: Fixture): unknown => {
  const launch = serviceDefinitionStore(f.space).read("stack-broker")!.record.value.launch;
  return launch.type === "adapter" ? launch.options.config : undefined;
};
const holds = (run: () => unknown) => { try { run(); return false; } catch (error) { return isCommandFailure(error) && error.outcome === "unknown"; } };
const admitted = (run: () => unknown) => { try { run(); return true; } catch { return false; } };
const refusedBeforeStop = (run: () => unknown) => { try { run(); return false; } catch (error) { return isCommandFailure(error) && error.code === "LIFECYCLE_BLOCKED" && error.message.includes("nothing was stopped"); } };

/** A stack-manager definition. The manager adapter is not registered in this suite, so it is not saved. */
const managerDefinition = (space: string, root: string) => ({ name: "stack-manager", record: { revision: "rev-manager", value: { space, launch: { type: "adapter", adapter: "manager-service", options: { root, runtime: "pty" } } } } }) as unknown as ServiceDefinitionSnapshot;

/** The manager's target resolution reads the registry. The entry is open so that it loads no trust
 *  material; nothing on this path compares the mode. */
const register = (space: string, root: string) => recordMesh({ space, server, root, mode: "open", ts: new Date().toISOString() });

/** A broker instance whose launch was refused before its child, as `startProcessService` leaves it. */
function refusedBrokerInstance(space: string): string {
  const definition = serviceDefinitionStore(space).read("stack-broker")!;
  const launch = definition.record.value.launch as { adapter: string; options: Record<string, unknown> };
  const id = randomUUID(), launchRequestId = randomUUID(), now = new Date().toISOString();
  serviceInstanceStore(space).commit(id, undefined, {
    schemaVersion: 1, instanceId: id, definition: "stack-broker", definitionRevision: definition.record.revision, space, host: processServiceHost(),
    requestId: launchRequestId, launchRequestId, state: "failed", launcher: requireProcessIdentity(process.pid), readiness: "not-checked",
    adapter: resolveServiceAdapter(launch.adapter, launch.options).pin, kernelStopRequired: true, supervisor: "none", foreground: false, createdAt: now, updatedAt: now,
  });
  return id;
}

/** A running instance record pinned to this process, as a started service leaves it. Nothing is launched. */
function runningInstance(space: string, definition: string): string {
  const id = randomUUID(), launchRequestId = randomUUID(), now = new Date().toISOString();
  serviceInstanceStore(space).commit(id, undefined, {
    schemaVersion: 1, instanceId: id, definition, definitionRevision: `rev-${definition}`, space, host: processServiceHost(),
    requestId: launchRequestId, launchRequestId, state: "running", launcher: requireProcessIdentity(process.pid), process: requireProcessIdentity(process.pid),
    readiness: "process-running", supervisor: "none", foreground: false, createdAt: now, updatedAt: now,
  });
  return id;
}

let scopePort = 4300;
type Preservable = { root: string; space: string; store: string; stack: StackJournal; sha256: string; revisions: () => string[] };

/** A controller stack whose recorded broker and manager run as this process, at a broker address
 *  no other fixture registers. */
function preservable(name: string, operation?: StackJournal["operation"]): Preservable {
  const root = join(sandbox, name), store = join(root, "store");
  mkdirSync(store, { recursive: true });
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const space = `space-${name}`, now = new Date().toISOString();
  const broker = runningInstance(space, "stack-broker"), manager = runningInstance(space, "stack-manager");
  const stack: StackJournal = {
    schemaVersion: 1, kind: "cotal-stack-controller", root, space, server: `nats://127.0.0.1:${scopePort++}`, mode: "auth", broker: { storeDir: store },
    members: [
      { role: "broker", definition: "stack-broker", instanceId: broker, state: "started" },
      { role: "auth", definition: "stack-auth", instanceId: null, state: "not-attempted" },
      { role: "delivery", definition: "stack-delivery", instanceId: null, state: "not-attempted" },
      { role: "manager", definition: "stack-manager", instanceId: manager, state: "started" },
    ],
    operation: operation ?? { id: randomUUID(), kind: "up", phase: "completed", recordedAt: now, withAgents: false }, updatedAt: now,
  };
  const revisions = () => [broker, manager].map((id) => serviceInstanceStore(space).read(id)!.record.revision);
  return { root, space, store, stack, sha256: writeStackJournal(root, undefined, stack).sha256, revisions };
}

/** The same stack at `cut-committed`, as a preserve leaves it when it stops after the manager's commit. */
function committedCut(name: string): Preservable {
  const operationId = randomUUID(), attemptId = `preserve-${randomUUID()}`;
  const f = preservable(name, { id: operationId, kind: "preserve", phase: "applying", recordedAt: new Date().toISOString(), withAgents: false, maintenanceAttemptId: attemptId });
  const member = (role: "broker" | "manager") => {
    const value = serviceInstanceStore(f.space).read(f.stack.members.find((row) => row.role === role)!.instanceId!)!.record.value;
    return { role, definition: value.definition, definitionRevision: value.definitionRevision, instanceId: value.instanceId, launchRequestId: value.launchRequestId, process: value.process! };
  };
  const binding = { stackOperationId: operationId, brokerDefinitionRevision: "rev-stack-broker", members: [member("broker"), member("manager")], manager: { instanceId: "manager-instance", epoch: 1, lifecycleUid: "manager-uid" } };
  const lock = acquireMaintenanceLock(f.root);
  const resume = writeMaintenanceResumeDocument(lock, { version: 1, inventory: { agents: [] }, launch: { runtime: "pty" } });
  beginMaintenanceCut(lock, { attemptId, space: f.space, mode: "auth", sourcePath: f.store, resume, launch: { server: f.stack.server, custody: "controller", controller: binding as never } });
  recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
  releaseMaintenanceLock(lock);
  return f;
}

async function preserveRefusal(f: Preservable): Promise<unknown> {
  try { await preserveControllerStack(f.root, undefined, []); } catch (error) { return error; }
  return undefined;
}

/** Nothing was written or stopped: no prepare intent, the same stack journal and member records. */
function untouched(f: Preservable, before: readonly string[], maintenance: string | undefined): boolean {
  return readPreservationPrepareIntent(f.root) === undefined && readStackJournal(f.root)?.sha256 === f.sha256 &&
    readMaintenanceJournal(f.root)?.state === maintenance && JSON.stringify(f.revisions()) === JSON.stringify(before);
}

console.log("rollback before the definition write");
{
  const f = rendered("untouched");
  const ready = rollbackRestoreWithBroker(f.lock, { asCoordinator: coordinator });
  await check("a rendered rewrite with the source revision live rolls the store back", ready.state === "ready");
  await check("its attempt-owned config is removed", !lstatSync(f.toConfig, { throwIfNoEntry: false }));
  await check("the cut still expects the source revision", cutController(ready.cut)!.brokerDefinitionRevision === f.reconfiguration.fromRevision);
}

console.log("rollback after an unjournaled forward write");
{
  const f = rendered("forward");
  const forward = rewrite(f, f.toConfig);
  const ready = rollbackRestoreWithBroker(f.lock, { asCoordinator: coordinator });
  await check("an attributable forward write is rolled back to the source config", ready.state === "ready" && liveConfig(f) === f.fromConfig);
  const expected = cutController(ready.cut)!.brokerDefinitionRevision;
  await check("the rollback writes a new revision that the cut then expects", expected !== forward && expected !== f.reconfiguration.fromRevision && expected === serviceDefinitionStore(f.space).read("stack-broker")!.record.revision);
  await check("the source config is unchanged", sha(readFileSync(f.fromConfig, "utf8")) === f.reconfiguration.fromConfigSha256);
}

console.log("holds instead of guessing");
{
  const foreign = rendered("foreign");
  const other = join(foreign.root, ".cotal", "other.conf");
  writeFileSync(other, "listen: 127.0.0.1:4222\n", { mode: 0o600 });
  const revision = rewrite(foreign, other);
  await check("a revision naming another config holds", holds(() => rollbackRestoreWithBroker(foreign.lock, { asCoordinator: coordinator })));
  await check("nothing was overwritten", serviceDefinitionStore(foreign.space).read("stack-broker")!.record.revision === revision && readMaintenanceJournal(foreign.root)?.state === "restore-ready");

  const changed = rendered("changed");
  rewrite(changed, changed.toConfig);
  writeFileSync(changed.toConfig, "changed\n", { mode: 0o600 });
  await check("a revision whose config no longer hashes to the journaled digest holds", holds(() => rollbackRestoreWithBroker(changed.lock, { asCoordinator: coordinator })));

  const source = rendered("source-changed");
  rewrite(source, source.toConfig);
  writeFileSync(source.fromConfig, "changed\n", { mode: 0o600 });
  await check("a changed source config holds the definition rollback", holds(() => rollbackRestoreWithBroker(source.lock, { asCoordinator: coordinator })));
  await check("the forward revision stays recorded and live", (readMaintenanceJournal(source.root) as { restore: { controllerReconfiguration?: { phase: string } } }).restore.controllerReconfiguration?.phase === "definition-committed" && liveConfig(source) === source.toConfig);
}

console.log("stack fence");
{
  const f = rendered("fence");
  const stack = { space: f.space, server, broker: { storeDir: f.store }, operation: { id: randomUUID(), phase: "completed" } } as unknown as StackJournal;
  await check("a pre-commit restore fences the stack", stackMaintenanceFence(f.root, stack).fenced);
  rollbackRestoreWithBroker(f.lock, { asCoordinator: coordinator });
  await check("a ready cut fences the stack", stackMaintenanceFence(f.root, stack).fenced);
  const none = join(sandbox, "none");
  mkdirSync(none);
  await check("a root with no maintenance journal is not fenced", !stackMaintenanceFence(none, stack).fenced);
  await check("a manager launch at a root with no maintenance journal carries no stack facts", maintenanceStackView(none, f.space) === undefined);
}

console.log("a settled active restore: manager launch facts, team boot and preserve");
{
  const a = activeRestore("active");
  await check("the restored stack admits its settled restore", admittedStackRestore(a.root) === a.attemptId);
  const view = maintenanceStackView(a.root, a.space);
  await check("a manager launch carries this stack's facts", view?.space === a.space && view.server === server && view.storeDir === a.stack.broker!.storeDir && view.operation.id === a.stack.operation.id && view.operation.phase === "completed");
  await check("a manager launch for another space carries none", maintenanceStackView(a.root, "other-space") === undefined);
  register(a.space, a.root);
  await check("a manager restart under the settled restore of its own stack is admitted", admitted(() => assertRestartAdmitted(managerDefinition(a.space, a.root))));
  await check("so is a broker restart", admitted(() => assertRestartAdmitted(serviceDefinitionStore(a.space).read("stack-broker")!)));
  let boot: unknown;
  try { stackResumeEligibility(a.root, a.space, { server, mode: "auth" }); } catch (error) { boot = error; }
  await check("team boot refuses the restored stack and names the restore", isCommandFailure(boot) && boot.code === "LIFECYCLE_BLOCKED" && (boot.target as { admittedRestore?: string }).admittedRestore === a.attemptId);
  let preserve: unknown;
  try { await preserveControllerStack(a.root, undefined, []); } catch (error) { preserve = error; }
  await check("a preserve refuses until the restore journal is retired, and names the cleanup", isCommandFailure(preserve) && preserve.code === "LIFECYCLE_BLOCKED" && (preserve.remedy ?? "").includes(`cotal backup cleanup-fallback ${a.attemptId}`));
  await check("neither refusal changed the journal", readMaintenanceJournal(a.root)?.state === "active");
}

console.log("a restart refuses before any stop when its start would be refused");
{
  const f = rendered("restart");
  register(f.space, f.root);
  const id = refusedBrokerInstance(f.space);
  const before = serviceInstanceStore(f.space).read(id)!.record.value;
  let refusal: unknown;
  try { await serviceAction({ positionals: ["restart", "stack-broker"], values: { yes: true, json: true } } as unknown as ParsedArgs, f.space); } catch (error) { refusal = error; }
  await check("a broker restart under a pre-commit restore refuses before its stop", isCommandFailure(refusal) && refusal.code === "LIFECYCLE_BLOCKED" && refusal.message.includes("nothing was stopped"));
  const after = serviceInstanceStore(f.space).read(id)!.record.value;
  await check("the broker instance record is unchanged", after.launchRequestId === before.launchRequestId && after.state === before.state && after.updatedAt === before.updatedAt);
  await check("a manager restart under a pre-commit restore refuses before its stop", refusedBeforeStop(() => assertRestartAdmitted(managerDefinition(f.space, f.root))));
  await check("the restart checks only read the journal", readMaintenanceJournal(f.root)?.state === "restore-ready");
}

console.log("a preserve refuses what the broker's stop would cut off, before any effect");
{
  // Control: with nothing outside the stack, the scope check passes and the capability proof, the
  // next read, refuses this fixture's manager, which has no protected launch identity.
  const clean = preservable("scope-clean");
  const cleanBefore = clean.revisions();
  const proof = await preserveRefusal(clean);
  await check("CONTROL: a stack with nothing outside it passes the scope check and reaches the capability proof", isCommandFailure(proof) && proof.code === "UNSUPPORTED" && proof.message.includes("preserved-exit stop contract"));
  await check("CONTROL: that refusal wrote and stopped nothing", untouched(clean, cleanBefore, undefined));

  const other = preservable("scope-other");
  const web = runningInstance(other.space, "web");
  const otherBefore = other.revisions();
  const stranded = await preserveRefusal(other);
  const dependants = isCommandFailure(stranded) ? (stranded.target as { dependants?: Array<{ definition: string; instanceId: string }> }).dependants ?? [] : [];
  await check("another live service instance in the space refuses the preserve and is named", isCommandFailure(stranded) && stranded.code === "LIFECYCLE_BLOCKED" && dependants.some((row) => row.definition === "web" && row.instanceId === web));
  await check("its remedy names the preserve to run again", isCommandFailure(stranded) && (stranded.remedy ?? "").includes("cotal down --preserve-state"));
  await check("no prepare intent, stack operation, maintenance journal or member stop was written", untouched(other, otherBefore, undefined));

  const shared = preservable("scope-shared");
  recordMesh({ space: "space-scope-neighbour", server: shared.stack.server, root: join(sandbox, "scope-neighbour"), mode: "open", ts: new Date().toISOString() });
  const sharedBefore = shared.revisions();
  const sharing = await preserveRefusal(shared);
  const named = isCommandFailure(sharing) ? sharing.target as { server?: string; spaces?: string[] } : {};
  await check("a shared broker address refuses the preserve before any stop and is named", isCommandFailure(sharing) && sharing.code === "LIFECYCLE_BLOCKED" && named.server === shared.stack.server && (named.spaces ?? []).includes("space-scope-neighbour"));
  await check("the shared-address refusal wrote and stopped nothing", untouched(shared, sharedBefore, undefined));

  const retry = committedCut("scope-retry");
  recordMesh({ space: "space-scope-retry-neighbour", server: retry.stack.server, root: join(sandbox, "scope-retry-neighbour"), mode: "open", ts: new Date().toISOString() });
  const retryBefore = retry.revisions();
  const held = await preserveRefusal(retry);
  await check("a retry of a committed cut checks the scope before any further stop", isCommandFailure(held) && held.code === "LIFECYCLE_BLOCKED" && (held.target as { server?: string }).server === retry.stack.server);
  await check("the committed cut keeps no new stop attempt and its members are unchanged", untouched(retry, retryBefore, "cut-committed") && (readMaintenanceJournal(retry.root) as { preservedStop?: unknown }).preservedStop === undefined);
}

rmSync(sandbox, { recursive: true, force: true });
if (previousHome === undefined) delete process.env.COTAL_HOME;
else process.env.COTAL_HOME = previousHome;
console.log(`\ncontroller restore smoke: ${passed} checks passed`);
emitSentinel({ passed, failed: 0 });
