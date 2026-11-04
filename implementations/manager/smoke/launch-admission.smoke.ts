// The manager service's launch admission under a maintenance journal. A resume or restore attempt
// launches only its own manager, at the start row it journaled and has not settled. Without an
// attempt, only a settled active controller restore of the same stack is admitted, through the
// shared `admittedControllerRestore`. Every other journal, legacy custody included, refuses.
// Journal-level only: no registry, broker, process or service record is read or started.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import {
  acquireMaintenanceLock, beginMaintenanceCut, beginOrdinaryResume, bindRestoreListener, bindRestoreTarget, completeMaintenanceCut,
  markRestoreActive, moveSamePathRestoreSource, prepareSamePathRestore, readMaintenanceJournal, recordPreservationManagerCommit,
  recordRestoreManagerCommit, requestControllerMemberStart, settleControllerMemberStart, writeMaintenanceResumeDocument,
  writeRestoreCommitIntent, type ControllerCutBinding, type ControllerStop, type RestoreListenerProof, type ServiceAdapterAttempt,
  type ServiceAdapterContext,
} from "@cotal-ai/workspace";
import { maintenanceAdmits } from "../src/service-adapter.js";

let passed = 0;
function check(name: string, condition: unknown): void {
  assert.ok(condition, name);
  passed++;
  console.log(`  ok ${name}`);
}

const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-manager-launch-admission-")));
const server = "nats://127.0.0.1:4222";
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const claim = () => ({ deadline: new Date(Date.now() + 60_000).toISOString(), coordinator: { pid: process.pid, host: hostname(), startedAt: new Date(0).toISOString(), id: "coordinator" } });

function controllerBinding(): ControllerCutBinding {
  const member = (role: "broker" | "delivery" | "manager", pid: number) => ({
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

/** A fresh root with its preserved store and resume document, under the maintenance lock. */
function fresh(name: string) {
  const root = join(sandbox, name), store = join(root, "store");
  mkdirSync(store, { recursive: true });
  const lock = acquireMaintenanceLock(root);
  const resume = writeMaintenanceResumeDocument(lock, { version: 1, inventory: { agents: [] }, launch: { runtime: "pty" } });
  return { root, store, lock, resume, space: `space-${name}` };
}

/** A ready controller cut. */
function readyCut(name: string) {
  const r = fresh(name);
  const binding = controllerBinding();
  const attemptId = `cut-${name}`;
  beginMaintenanceCut(r.lock, { attemptId, space: r.space, mode: "auth", sourcePath: r.store, resume: r.resume, launch: { server, custody: "controller", controller: binding as never } });
  recordPreservationManagerCommit(r.lock, { operation: "commitPreservation", attemptId, state: "preserved" });
  completeMaintenanceCut(r.lock, {
    attemptId, observedAt: new Date().toISOString(),
    managerCommit: { operation: "commitPreservation", attemptId, state: "preserved" },
    stopped: { manager: true, broker: true, localProcesses: true },
    listener: { endpoint: server, unreachable: true },
    controllerStops: stops(binding),
  });
  return { ...r, binding, manager: binding.members.find((member) => member.role === "manager")! };
}

function context(space: string, instanceId: string, extra: { attempt?: ServiceAdapterAttempt; stack?: ServiceAdapterContext["stack"] } = {}): ServiceAdapterContext {
  return { space, definition: "stack-manager", definitionRevision: "rev-manager-1", instanceId, launchRequestId: randomUUID(), stateDirectory: sandbox, options: { root: sandbox, runtime: "pty" }, ...extra };
}

const admits = (root: string, launch: ServiceAdapterContext) => maintenanceAdmits(root, server, launch, launch.attempt);

console.log("no maintenance journal");
{
  const root = join(sandbox, "none");
  mkdirSync(root);
  check("a root with no maintenance journal admits an ordinary launch", admits(root, context("space-none", randomUUID())));
}

console.log("legacy custody and a ready controller cut");
{
  const legacy = fresh("legacy");
  beginMaintenanceCut(legacy.lock, { attemptId: "cut-legacy", space: legacy.space, mode: "auth", sourcePath: legacy.store, resume: legacy.resume, launch: { server } });
  check("a legacy cut refuses an ordinary launch", !admits(legacy.root, context(legacy.space, randomUUID())));
  check("a legacy cut refuses an attempt launch", !admits(legacy.root, context(legacy.space, randomUUID(), { attempt: { kind: "maintenance-resume", attemptId: "cut-legacy" } })));
  const ready = readyCut("ready");
  check("a ready cut refuses an ordinary manager launch", !admits(ready.root, context(ready.space, ready.manager.instanceId)));
  check("a ready cut refuses an attempt launch, which it has not journaled", !admits(ready.root, context(ready.space, ready.manager.instanceId, { attempt: { kind: "maintenance-resume", attemptId: "cut-ready" } })));
}

console.log("a controller resume launches only its own journaled manager start");
{
  const r = readyCut("resume");
  const attemptId = `resume-${randomUUID()}`;
  const attempt: ServiceAdapterAttempt = { kind: "maintenance-resume", attemptId };
  beginOrdinaryResume(r.lock, { attemptId, launch: { server, storeDir: r.store, runtime: "pty", detached: true, serverName: "n", serverNonce: "n", custody: "controller", controller: { stackOperationId: randomUUID(), started: [] } } });
  check("before its start row the manager launch is refused", !admits(r.root, context(r.space, r.manager.instanceId, { attempt })));
  requestControllerMemberStart(r.lock, { role: "manager", instanceId: r.manager.instanceId, priorLaunchRequestId: r.manager.launchRequestId });
  check("the attempt's journaled manager start is admitted", admits(r.root, context(r.space, r.manager.instanceId, { attempt })));
  check("another attempt id is refused", !admits(r.root, context(r.space, r.manager.instanceId, { attempt: { kind: "maintenance-resume", attemptId: `resume-${randomUUID()}` } })));
  check("another instance is refused", !admits(r.root, context(r.space, randomUUID(), { attempt })));
  check("a launch without the attempt is refused", !admits(r.root, context(r.space, r.manager.instanceId)));
  settleControllerMemberStart(r.lock, "manager", randomUUID(), "running");
  check("a settled start row admits no second launch", !admits(r.root, context(r.space, r.manager.instanceId, { attempt })));
}

console.log("a controller restore, its committed relaunch and its settled active state");
{
  const r = readyCut("restore");
  const broker = r.binding.members.find((member) => member.role === "broker")!;
  const attemptId = `restore-${randomUUID()}`;
  const attempt: ServiceAdapterAttempt = { kind: "maintenance-resume", attemptId };
  prepareSamePathRestore(r.lock, { attemptId, targetPath: r.store, fallbackPath: join(r.root, `.cotal-restore-fallback-${attemptId}`), claim: claim() });
  moveSamePathRestoreSource(r.lock);
  mkdirSync(r.store);
  const bound = bindRestoreTarget(r.lock);
  const stackOperationId = randomUUID();
  writeRestoreCommitIntent(r.lock, { server, runtime: "pty", serverName: "n", serverNonce: "n", custody: "controller", controller: { stackOperationId, started: [] } } as never);
  const brokerLaunch = randomUUID();
  requestControllerMemberStart(r.lock, { role: "broker", instanceId: broker.instanceId, priorLaunchRequestId: broker.launchRequestId });
  settleControllerMemberStart(r.lock, "broker", brokerLaunch, "running");
  const proof: RestoreListenerProof = {
    kind: "controller", attemptId, serverName: `${attemptId}-n`, serverNonce: "n",
    processOwner: { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id: `controller-broker-${brokerLaunch}` },
    serverEndpoint: server, target: bound.restore.target!,
    instance: { instanceId: broker.instanceId, launchRequestId: brokerLaunch, process: { pid: process.pid, token: "token-live" } },
  };
  bindRestoreListener(r.lock, proof, { controllerInstanceRunning: () => true });
  requestControllerMemberStart(r.lock, { role: "manager", instanceId: r.manager.instanceId, priorLaunchRequestId: r.manager.launchRequestId });
  check("a restore at commit intent admits its journaled manager start", admits(r.root, context(r.space, r.manager.instanceId, { attempt })));
  check("a restore at commit intent refuses an ordinary launch", !admits(r.root, context(r.space, r.manager.instanceId)));
  const managerLaunch = randomUUID();
  settleControllerMemberStart(r.lock, "manager", managerLaunch, "running");
  recordRestoreManagerCommit(r.lock, proof, { attemptId, state: "awaitingFinalize", durableCommitToken: hex("9") });
  check("a committed restore refuses a relaunch it has not journaled", !admits(r.root, context(r.space, r.manager.instanceId, { attempt })));
  requestControllerMemberStart(r.lock, { role: "manager", instanceId: r.manager.instanceId, priorLaunchRequestId: managerLaunch }, { priorManagerGone: (row) => row.launchRequestId === managerLaunch });
  check("a committed restore admits the relaunch row it journaled", admits(r.root, context(r.space, r.manager.instanceId, { attempt })));
  settleControllerMemberStart(r.lock, "manager", randomUUID(), "running");
  check("a settled relaunch row admits no second launch", !admits(r.root, context(r.space, r.manager.instanceId, { attempt })));
  const view = { space: r.space, server, storeDir: r.store, operation: { id: stackOperationId, phase: "completed" } };
  check("a manager-committed restore refuses an ordinary launch, even with this stack's facts", !admits(r.root, context(r.space, r.manager.instanceId, { stack: view })));
  markRestoreActive(r.lock, proof, { attemptId, state: "active", durableCommitToken: hex("9") });
  check("a settled active restore of this stack admits an ordinary launch", admits(r.root, context(r.space, r.manager.instanceId, { stack: view })));
  check("an attempt launch under an active restore is refused", !admits(r.root, context(r.space, r.manager.instanceId, { stack: view, attempt })));
  check("a launch without the stack's facts is refused", !admits(r.root, context(r.space, r.manager.instanceId)));
  check("an unsettled restore operation is refused", !admits(r.root, context(r.space, r.manager.instanceId, { stack: { ...view, operation: { ...view.operation, phase: "applying" } } })));
  check("a stack journal naming another space is refused", !admits(r.root, context(r.space, r.manager.instanceId, { stack: { ...view, space: "other-space" } })));
  check("a launch for another space is refused", !admits(r.root, context("other-space", r.manager.instanceId, { stack: view })));
  check("another broker address is refused", !maintenanceAdmits(r.root, "nats://127.0.0.1:4333", context(r.space, r.manager.instanceId, { stack: view }), undefined));
  check("another store is refused", !admits(r.root, context(r.space, r.manager.instanceId, { stack: { ...view, storeDir: join(r.root, "elsewhere") } })));
  check("admission only reads the journal", readMaintenanceJournal(r.root)?.state === "active");
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\nmanager launch admission smoke: ${passed} checks passed`);
emitSentinel({ passed, failed: 0 });
