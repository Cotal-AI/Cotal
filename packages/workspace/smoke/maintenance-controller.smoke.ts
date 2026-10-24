// Controller-custody restore and resume journal writers: the start rows a restore journals before
// each member start, the committed-manager relaunch row, the broker definition rewrite and its
// rollback, the journaled new broker instance, and the read-only admission of a settled active
// restore. Journal-level only: no broker, process or store record is started or read.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import {
  acquireMaintenanceLock,
  admittedControllerRestore,
  beginMaintenanceCut,
  bindRestoreListener,
  bindRestoreTarget,
  completeMaintenanceCut,
  controllerAttemptBinding,
  controllerAttemptBroker,
  cutController,
  isMaintenanceError,
  markRestoreActive,
  prepareAlternateRestore,
  prepareSamePathRestore,
  moveSamePathRestoreSource,
  readMaintenanceJournal,
  recordControllerAttemptBroker,
  recordPreservationManagerCommit,
  recordRestoreManagerCommit,
  recordRestoreReconfiguration,
  requestControllerMemberStart,
  rollbackRestore,
  settleControllerMemberStart,
  writeMaintenanceResumeDocument,
  writeRestoreCommitIntent,
  type ControllerCutBinding,
  type ControllerReconfiguration,
  type ControllerStop,
  type MaintenanceErrorCode,
  type MaintenanceLock,
  type RestoreListenerProof,
} from "../src/maintenance.js";

let passed = 0;
function check(name: string, condition: unknown): void {
  assert.ok(condition, name);
  passed++;
  console.log(`  ok ${name}`);
}

function expectCode(name: string, code: MaintenanceErrorCode, operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => isMaintenanceError(error) && error.code === code, name);
  passed++;
  console.log(`  ok ${name}`);
}

const sandbox = mkdtempSync(join(tmpdir(), "cotal-maintenance-controller-"));
const server = "nats://127.0.0.1:4222";
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

function controllerBinding(): ControllerCutBinding {
  const member = (role: "broker" | "auth" | "delivery" | "manager", pid: number) => ({
    role, definition: `stack-${role}`, definitionRevision: `rev-${role}-1`, instanceId: randomUUID(), launchRequestId: randomUUID(),
    process: { pid, token: `token-${role}` },
  });
  return {
    stackOperationId: randomUUID(), brokerDefinitionRevision: "rev-broker-1",
    members: [member("broker", 41), member("delivery", 42), member("manager", 43)],
    manager: { instanceId: "manager-instance", epoch: 2, lifecycleUid: "manager-uid" },
  };
}

function stops(binding: ControllerCutBinding): ControllerStop[] {
  const observedAt = new Date().toISOString();
  return binding.members.map((member) => ({
    role: member.role, instanceId: member.instanceId, launchRequestId: member.launchRequestId,
    receipt: member.role === "manager" ? { kind: "preserved-exit", requestId: randomUUID(), scopeSha256: hex("a"), observedAt }
      : member.role === "broker" ? { kind: "kernel-exit", requestId: randomUUID(), scopeSha256: hex("b"), observedAt }
        : { kind: "process-exit", requestId: randomUUID(), observedAt },
  }) as ControllerStop);
}

/** A ready controller cut over a fresh root. */
function readyCut(name: string): { root: string; store: string; lock: MaintenanceLock; binding: ControllerCutBinding } {
  const root = join(sandbox, name), store = join(root, "store");
  mkdirSync(store, { recursive: true });
  const real = { root: realpathSync.native(root), store: realpathSync.native(store) };
  const lock = acquireMaintenanceLock(real.root);
  const resume = writeMaintenanceResumeDocument(lock, { version: 1, inventory: { agents: [] }, launch: { runtime: "pty" } });
  const binding = controllerBinding();
  const attemptId = `cut-${name}`;
  beginMaintenanceCut(lock, {
    attemptId, space: `space-${name}`, mode: "auth", sourcePath: real.store, resume,
    launch: { server, custody: "controller", controller: binding as never },
  });
  recordPreservationManagerCommit(lock, { operation: "commitPreservation", attemptId, state: "preserved" });
  completeMaintenanceCut(lock, {
    attemptId, observedAt: new Date().toISOString(),
    managerCommit: { operation: "commitPreservation", attemptId, state: "preserved" },
    stopped: { manager: true, broker: true, localProcesses: true },
    listener: { endpoint: server, unreachable: true },
    controllerStops: stops(binding),
  });
  return { ...real, lock, binding };
}

const claim = () => ({ deadline: new Date(Date.now() + 60_000).toISOString(), coordinator: { pid: process.pid, host: hostname(), startedAt: new Date(0).toISOString(), id: "coordinator" } });
const controllerLaunch = () => ({ custody: "controller", controller: { stackOperationId: randomUUID(), started: [] } });

/** An alternate controller restore at a bound target, with its attempt-owned config file. */
function alternate(name: string): ReturnType<typeof readyCut> & { attemptId: string; targetPath: string; config: string; reconfiguration: ControllerReconfiguration } {
  const p = readyCut(name);
  const attemptId = `restore-${randomUUID()}`;
  const targetPath = join(p.root, "target");
  prepareAlternateRestore(p.lock, { attemptId, targetPath, claim: claim() });
  mkdirSync(targetPath);
  const bound = bindRestoreTarget(p.lock);
  const config = join(p.root, `server.restore-${attemptId}.conf`);
  writeFileSync(config, "jetstream { store_dir: \"target\" }\n", { mode: 0o600 });
  const reconfiguration: ControllerReconfiguration = {
    fromRevision: "rev-broker-1", fromOptionsSha256: hex("c"), fromConfigPath: join(p.root, "server.conf"), fromConfigSha256: hex("d"),
    toConfigPath: config, toConfigSha256: hex("e"), toStoreIdentity: bound.restore.target!, phase: "rendered",
  };
  return { ...p, attemptId, targetPath, config, reconfiguration };
}

function owned(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return { label: "config" as const, path, dev: stat.dev.toString(), ino: stat.ino.toString() };
}

console.log("controller restore reconfiguration");
{
  const p = alternate("reconfigure");
  expectCode("rendered needs its attempt-owned config with an inode", "invalid-transition", () => recordRestoreReconfiguration(p.lock, p.reconfiguration));
  recordRestoreReconfiguration(p.lock, p.reconfiguration, owned(p.config));
  expectCode("rendered cannot skip to rolled-back", "invalid-transition", () => recordRestoreReconfiguration(p.lock, { ...p.reconfiguration, toRevision: "rev-broker-2", rollbackRevision: "rev-broker-3", phase: "rolled-back" }));
  expectCode("a fixed field cannot change between phases", "invalid-transition", () => recordRestoreReconfiguration(p.lock, { ...p.reconfiguration, toConfigSha256: hex("f"), toRevision: "rev-broker-2", phase: "definition-committed" }));
  expectCode("store rollback refuses while a rendered rewrite has no live revision", "rollback-forbidden", () => rollbackRestore(p.lock, { asCoordinator: claim().coordinator }));
  expectCode("store rollback refuses a live revision other than the source", "rollback-forbidden", () => rollbackRestore(p.lock, { asCoordinator: claim().coordinator, controllerDefinition: { liveRevision: "rev-broker-2" } }));
  recordRestoreReconfiguration(p.lock, { ...p.reconfiguration, toRevision: "rev-broker-2", phase: "definition-committed" });
  expectCode("store rollback refuses after the definition write", "rollback-forbidden", () => rollbackRestore(p.lock, { asCoordinator: claim().coordinator, controllerDefinition: { liveRevision: "rev-broker-2" } }));
  recordRestoreReconfiguration(p.lock, { ...p.reconfiguration, toRevision: "rev-broker-2", phase: "rolling-back" });
  expectCode("rolled-back must name the rollback revision the cut then expects, not the source", "journal-corrupt", () => recordRestoreReconfiguration(p.lock, { ...p.reconfiguration, toRevision: "rev-broker-2", rollbackRevision: "rev-broker-1", phase: "rolled-back" }));
  const rolled = recordRestoreReconfiguration(p.lock, { ...p.reconfiguration, toRevision: "rev-broker-2", rollbackRevision: "rev-broker-3", phase: "rolled-back" });
  check("rolled-back rebinds the cut's broker revision in the same write", cutController(rolled.cut)!.brokerDefinitionRevision === "rev-broker-3");
  check("the cut's broker member keeps its own revision", cutController(rolled.cut)!.members.find((member) => member.role === "broker")!.definitionRevision === "rev-broker-1");
  const ready = rollbackRestore(p.lock, { asCoordinator: claim().coordinator, controllerDefinition: { liveRevision: "rev-broker-3" } });
  check("store rollback returns to ready once the definition is back", ready.state === "ready");
  check("the attempt-owned config is removed by its recorded inode", !lstatSync(p.config, { throwIfNoEntry: false }));
  const next = controllerAttemptBroker(ready);
  check("the next attempt must start a new broker instance (amended rollback row 4)", next.required && next.instance === undefined);
}

console.log("restore commit intent journals member starts and a new broker");
{
  const p = alternate("commit");
  recordRestoreReconfiguration(p.lock, p.reconfiguration, owned(p.config));
  recordRestoreReconfiguration(p.lock, { ...p.reconfiguration, toRevision: "rev-broker-2", phase: "definition-committed" });
  expectCode("a controller restore needs its controller binding at commit intent", "journal-corrupt", () => writeRestoreCommitIntent(p.lock, { server, runtime: "pty" }));
  writeRestoreCommitIntent(p.lock, { server, runtime: "pty", serverName: "n", serverNonce: "n", ...controllerLaunch() } as never);
  const required = controllerAttemptBroker(readMaintenanceJournal(p.root)!);
  check("a rewritten definition requires a new broker instance before it is journaled", required.required && !required.instance);
  const retiredId = p.binding.members.find((member) => member.role === "broker")!.instanceId;
  expectCode("the new broker cannot reuse the retired record's instance", "invalid-transition", () => recordControllerAttemptBroker(p.lock, { instanceId: retiredId, launchRequestId: randomUUID() }));
  const pair = { instanceId: randomUUID(), launchRequestId: randomUUID() };
  recordControllerAttemptBroker(p.lock, pair);
  check("the new broker pair is journaled as reconfiguredBroker", readMaintenanceJournal(p.root)!.state === "commit-intent" && (readMaintenanceJournal(p.root) as { restore: { reconfiguredBroker?: unknown } }).restore.reconfiguredBroker !== undefined);
  check("recording the same pair again is a no-op", recordControllerAttemptBroker(p.lock, pair) !== undefined);
  expectCode("another pair is never journaled over it", "invalid-transition", () => recordControllerAttemptBroker(p.lock, { instanceId: randomUUID(), launchRequestId: randomUUID() }));
  const delivery = p.binding.members.find((member) => member.role === "delivery")!;
  requestControllerMemberStart(p.lock, { role: "delivery", instanceId: delivery.instanceId, priorLaunchRequestId: delivery.launchRequestId });
  const row = controllerAttemptBinding(readMaintenanceJournal(p.root)!)!.started.at(-1)!;
  check("a delivery start is journaled requested before its call", row.role === "delivery" && row.state === "requested" && row.outcome === undefined);
  const launched = randomUUID();
  settleControllerMemberStart(p.lock, "delivery", launched, "running");
  check("its settle records the launch request and outcome", controllerAttemptBinding(readMaintenanceJournal(p.root)!)!.started.at(-1)!.launchRequestId === launched);
  expectCode("a settled row is not settled twice", "invalid-transition", () => settleControllerMemberStart(p.lock, "delivery", randomUUID(), "running"));
}

console.log("committed manager relaunch row and active admission");
{
  const p = readyCut("same-path");
  const attemptId = `restore-${randomUUID()}`;
  prepareSamePathRestore(p.lock, { attemptId, targetPath: p.store, fallbackPath: join(p.root, `.cotal-restore-fallback-${attemptId}`), claim: claim() });
  moveSamePathRestoreSource(p.lock);
  mkdirSync(p.store);
  const bound = bindRestoreTarget(p.lock);
  const launch = controllerLaunch();
  writeRestoreCommitIntent(p.lock, { server, runtime: "pty", serverName: "n", serverNonce: "n", ...launch } as never);
  check("a same-path restore runs the cut's own broker instance", controllerAttemptBroker(readMaintenanceJournal(p.root)!).required === false);
  const broker = p.binding.members.find((member) => member.role === "broker")!;
  const manager = p.binding.members.find((member) => member.role === "manager")!;
  const brokerLaunch = randomUUID();
  requestControllerMemberStart(p.lock, { role: "broker", instanceId: broker.instanceId, priorLaunchRequestId: broker.launchRequestId });
  settleControllerMemberStart(p.lock, "broker", brokerLaunch, "running");
  const proof: RestoreListenerProof = {
    kind: "controller", attemptId, serverName: `${attemptId}-n`, serverNonce: "n",
    processOwner: { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id: `controller-broker-${brokerLaunch}` },
    serverEndpoint: server, target: bound.restore.target!,
    instance: { instanceId: broker.instanceId, launchRequestId: brokerLaunch, process: { pid: process.pid, token: "token-live" } },
  };
  expectCode("a controller proof needs the live instance check", "listener-proof-mismatch", () => bindRestoreListener(p.lock, proof));
  expectCode("a controller proof at the cut's own launch request is refused", "listener-proof-mismatch", () => bindRestoreListener(p.lock, { ...proof, processOwner: { ...proof.processOwner, id: `controller-broker-${broker.launchRequestId}` }, instance: { ...proof.instance!, launchRequestId: broker.launchRequestId } }, { controllerInstanceRunning: () => true }));
  bindRestoreListener(p.lock, proof, { controllerInstanceRunning: () => true });
  const managerLaunch = randomUUID();
  requestControllerMemberStart(p.lock, { role: "manager", instanceId: manager.instanceId, priorLaunchRequestId: manager.launchRequestId });
  settleControllerMemberStart(p.lock, "manager", managerLaunch, "running");
  recordRestoreManagerCommit(p.lock, proof, { attemptId, state: "awaitingFinalize", durableCommitToken: hex("9") });
  expectCode("after commitment no other member may start", "invalid-transition", () => requestControllerMemberStart(p.lock, { role: "broker", instanceId: broker.instanceId, priorLaunchRequestId: brokerLaunch }));
  expectCode("a manager relaunch needs its exact exit proven", "invalid-transition", () => requestControllerMemberStart(p.lock, { role: "manager", instanceId: manager.instanceId, priorLaunchRequestId: managerLaunch }));
  expectCode("an unproven exit holds the relaunch", "invalid-transition", () => requestControllerMemberStart(p.lock, { role: "manager", instanceId: manager.instanceId, priorLaunchRequestId: managerLaunch }, { priorManagerGone: () => false }));
  requestControllerMemberStart(p.lock, { role: "manager", instanceId: manager.instanceId, priorLaunchRequestId: managerLaunch }, { priorManagerGone: (row) => row.launchRequestId === managerLaunch });
  check("a proven exit journals the manager relaunch row first", controllerAttemptBinding(readMaintenanceJournal(p.root)!)!.started.at(-1)!.priorLaunchRequestId === managerLaunch);
  const view = { space: "space-same-path", server, storeDir: p.store, operation: { id: launch.controller.stackOperationId, phase: "completed" } };
  check("a manager-committed restore is not admitted", admittedControllerRestore(p.root, view) === undefined);
  markRestoreActive(p.lock, proof, { attemptId, state: "active", durableCommitToken: hex("9") });
  check("a settled active restore of this stack is admitted", admittedControllerRestore(p.root, view)?.restore.attemptId === attemptId);
  check("an unsettled restore operation is not admitted", admittedControllerRestore(p.root, { ...view, operation: { ...view.operation, phase: "applying" } }) === undefined);
  check("a foreign space is not admitted", admittedControllerRestore(p.root, { ...view, space: "other-space" }) === undefined);
  check("another address is not admitted", admittedControllerRestore(p.root, { ...view, server: "nats://127.0.0.1:4333" }) === undefined);
  check("another store is not admitted", admittedControllerRestore(p.root, { ...view, storeDir: join(p.root, "elsewhere") }) === undefined);
  check("admission only reads the journal", readMaintenanceJournal(p.root)?.state === "active");
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\nmaintenance controller smoke: ${passed} checks passed`);
emitSentinel({ passed, failed: 0 });
