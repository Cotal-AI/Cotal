/**
 * The two #4005 review findings, through Manager.start and startAgent.
 *
 * A recorded lifecycle is retired after registration, so the requester is minted for the serving
 * epoch and not for epoch 0. A custody write that fails after launch stops that seat and does not
 * own it. The rollback still retires the footprint, at the serving epoch when this manager has one.
 * A preserved row with a resume pending, and a delegated row, are not retired here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, mintLifecycleUid, newIdentity, principalKey, remoteManagerActors, registry } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { readUserCustody, writeUserCustody } from "../src/resume.js";

const scratch = process.env.COTAL_PROOF_TMP ?? tmpdir();
const root = mkdtempSync(join(scratch, "user-custody-startup-"));
process.env.COTAL_HOME = join(root, "account");
mkdirSync(process.env.COTAL_HOME, { recursive: true });
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const trace: Array<{ kind: string; epoch?: number; uid?: string }> = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));

const endpoint = CotalEndpoint.prototype as unknown as Record<string, unknown>;
for (const method of ["start", "setActivity", "stop", "releaseManagerLease", "releaseDaemonRenewalLease"]) endpoint[method] = async () => {};
endpoint.acquireManagerLease = async () => 1;
endpoint.readOwnManagerLease = async () => undefined;
endpoint.serveLiveness = () => {};

function remote(instanceId: string, behavior: Record<string, unknown> = {}) {
  return {
    owner, instanceId, lifecycleUid: mintLifecycleUid(), actors: remoteManagerActors(instanceId),
    identities: { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() },
    supervisorCreds: "", executorCreds: "", serveCreds: "", goalWriterCreds: "", sessionLedgerCreds: "",
    serveGrant: { epoch: 7 }, renewExecutor: async () => "",
    agentBearerExchangeUrl: "https://auth.example.test", mintSessionServing: async () => "",
    mintRetirementRequester: async (args: { serveEpoch: number }) => { trace.push({ kind: "requester", epoch: args.serveEpoch }); throw new Error("fixture: no network rail"); },
    prepareAgentRetirement: async (args: { target: { lifecycleUid: string } }) => { trace.push({ kind: "prepare", uid: args.target.lifecycleUid }); },
    validateRetainedAgent: async () => { throw new Error("unused"); }, scanGoalIndex: async () => [], authorizeAdmin: async () => false,
    ...behavior,
  };
}

function record(workspaceRoot: string, instanceId: string, extra: Record<string, unknown> = {}) {
  writeUserCustody(workspaceRoot, {
    version: "cotal-user-custody/v1", space: "demo", instanceId, name: "worker",
    id: principalKey(owner, "worker").key, lifecycleUid: mintLifecycleUid(), userOwner: owner, delegated: false, ...extra,
  } as never);
}

function manager(workspaceRoot: string, authority: ReturnType<typeof remote>, opts: Record<string, unknown> = {}) {
  const started = new Manager({ space: "demo", runtime: "pty", workspaceRoot, remoteAuthority: authority, ...opts } as never) as unknown as Record<string, any>;
  started.attach.start = async () => {};
  started.attach.stop = async () => {};
  started.inspectConnectorsAtBoot = async () => {};
  started.startGoalWriter = async () => {};
  started.startSessionPlane = async () => {};
  started.stopServiceServe = async () => { started.serviceServe = undefined; };
  started.registerManagerService = async () => {
    await tick();
    await tick();
    started.serviceServe = { grant: authority.serveGrant };
    trace.push({ kind: "registered", epoch: authority.serveGrant.epoch });
  };
  return started;
}

let failed = 0;
try {
  {
    trace.length = 0;
    const workspace = join(root, "epoch");
    const instance = mintLifecycleUid();
    record(workspace, instance);
    const authority = remote(instance, { mintRetirementRequester: async (args: { serveEpoch: number }) => {
      trace.push({ kind: "requester", epoch: args.serveEpoch });
      if (args.serveEpoch !== 7) throw new Error("conflict: stale manager serve epoch");
      throw new Error("fixture: current epoch reached");
    } });
    const started = manager(workspace, authority);
    await started.start();
    await started.userCustodyReconcile;
    await tick();
    const calls = trace.filter((item) => item.kind === "requester");
    assert.deepEqual(calls, [{ kind: "requester", epoch: 7 }]);
    assert.equal(started.serviceServe.grant.epoch, 7);
    assert.equal(readUserCustody(workspace, "demo", instance).length, 1);
    assert.match(started.retiring.get("worker").lastError, /current epoch reached/);
    await started.stop();
  }

  {
    trace.length = 0;
    const workspace = join(root, "write-failure");
    const instance = mintLifecycleUid();
    const started = manager(workspace, remote(instance));
    started.userMode = true;
    started.managerInstanceId = instance;
    started.managerServeIdentity = started.remoteAuthority.identities.serve;
    started.serviceServe = { grant: { epoch: 7 } };
    mkdirSync(join(workspace, ".cotal", "agents"), { recursive: true });
    writeFileSync(join(workspace, ".cotal", "agents", "worker.md"), "---\nname: worker\n---\n");
    writeFileSync(join(workspace, ".cotal", "user-custody"), "not a directory\n");
    let state = "running";
    let stopCalls = 0;
    const handle = {
      name: "worker", kind: "fixture", reference: { kind: "fixture", id: "seat1" }, status: () => state,
      stop: () => { stopCalls += 1; state = "exited"; }, waitForExit: async () => {}, release: () => {}, interrupt: () => {},
      attach: () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} }),
    };
    started.runtime = { kind: "fixture", streamsTerminal: false, spawn: () => handle };
    started.ep = { ref: () => ({ id: "fixture.manager" }), on: () => {}, off: () => {}, waitForPresenceSnapshot: async () => {}, getRoster: () => [], stop: async () => {}, readOwnManagerLease: async () => undefined, releaseDaemonRenewalLease: async () => {} };
    const connector = { kind: "connector", name: "custody_fixture", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
    registry.register(connector as never);
    const uid = mintLifecycleUid();
    started.provisionUserAgent = async () => ({ owner, lifecycleUid: uid, files: {}, launch: { owner, actor: "worker", sentinelCredsPath: "", bearerCmd: [] } });
    const reply = await started.startAgent({ name: "worker", agent: connector.name, events: false, cwd: workspace }, principalKey(owner, "operator").key);
    await Promise.all([...started.deprovisioningFlight.values()]);
    await tick();
    assert.equal(reply.ok, false);
    assert.match(reply.error, /ENOTDIR/);
    assert.equal(started.agents.has("worker"), false);
    assert.equal(state, "exited");
    assert.equal(stopCalls, 1);
    assert.equal(trace.find((item) => item.kind === "requester")?.epoch, 7);
    assert.equal(trace.some((item) => item.kind === "prepare"), true);
  }

  for (const kind of ["preserved", "delegated"] as const) {
    trace.length = 0;
    const workspace = join(root, kind);
    const instance = mintLifecycleUid();
    record(workspace, instance, { [kind]: true });
    const started = manager(workspace, remote(instance), kind === "preserved" ? { resumeAttemptId: "resume-1" } : {});
    await started.start();
    await started.userCustodyReconcile;
    assert.equal(trace.some((item) => item.kind === "prepare"), false);
    assert.equal(readUserCustody(workspace, "demo", instance).length, 1);
    await started.stop();
  }
  console.log("user-custody-startup: passed");
} catch (error) {
  failed = 1;
  console.error(error);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed);
