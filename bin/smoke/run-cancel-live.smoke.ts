import assert from "node:assert/strict";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
const home = mkdtempSync(join(tmpdir(), "cotal-cancel-home-"));
process.env.COTAL_HOME = home;
const core = await import("@cotal-ai/core");
const workspace = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
await import("@cotal-ai/runtime");
const { connect } = await import("@nats-io/transport-node");
const { bootBroker } = await import("../../implementations/manager/smoke/_boot-broker.js");
const { bootDeliveryDaemon } = await import("../../implementations/manager/smoke/_boot-delivery.js");
const space = `cancel-live-${Date.now().toString(36)}`;
const auth = await core.createSpaceAuth(space);
const broker = await bootBroker(auth);
const root = mkdtempSync(join(tmpdir(), "cotal-cancel-workspace-"));
let manager: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
let pass = 0;
const check = (name: string, condition: unknown): void => {
  assert.ok(condition, name);
  pass++;
  console.log(`  ok ${name}`);
};
async function client() {
  const identity = core.newIdentity();
  const uid = core.mintLifecycleUid();
  const issued = { generation: core.mintGeneration(), acceptedToken: core.mintAcceptedToken() };
  const caller = { owner: core.DEV_OWNER, actor: identity.id, uid, generation: issued.generation } as import("@cotal-ai/core").EpCaller;
  const creds = await core.withIssuerSession({ servers: broker.servers, space, auth, tls: false }, session =>
    core.mintCreds(auth, identity, "agent", { lifecycleUid: uid, capabilities: ["run"], expiresInSeconds: 300, issued,
      issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] } }));
  const nc = await connect({ servers: broker.servers, ...core.standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  connections.push(nc);
  const discovered = await core.resolveService(nc, space, "manager", caller, { deadlineMs: 10_000 });
  const pinnedIssued = { generation: core.mintGeneration(), acceptedToken: core.mintAcceptedToken() };
  const pinnedCaller = { ...caller, generation: pinnedIssued.generation } as import("@cotal-ai/core").EpCaller;
  const pinnedCreds = await core.withIssuerSession({ servers: broker.servers, space, auth, tls: false }, session =>
    core.mintCreds(auth, identity, "agent", { lifecycleUid: uid, capabilities: ["run"], expiresInSeconds: 300, issued: pinnedIssued,
      endpointCapabilities: [{ endpoint: "manager", command: "run-cancel", instanceId: discovered.responder.instanceId }],
      issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] } }));
  const pinnedNc = await connect({ servers: broker.servers, ...core.standaloneConnectOpts({ creds: pinnedCreds, tls: false }), maxReconnectAttempts: 0 });
  connections.push(pinnedNc);
  const service = await core.resolveService(pinnedNc, space, "manager", pinnedCaller, { deadlineMs: 10_000 });
  return { caller: pinnedCaller, service, invoke: async (command: string, args?: Record<string, unknown>) =>
    (await core.invokeCommand(pinnedNc, space, command === "run-cancel" ? { ...service, pinnedInstanceId: service.responder.instanceId } : service,
      command, args, { deadlineMs: 30_000 })).reply };
}
try {
  workspace.saveSpaceAuth(workspace.authDir(root), auth);
  await core.setupSpaceStreams({ servers: broker.servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  workspace.recordMesh({ space, server: broker.servers, root, mode: "auth", ts: new Date().toISOString() });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspace.workspaceSecretStore(root).identity });
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const original = await client();
  const sibling = await client();
  check("actual Describe advertises run-cancel", original.service.commands.has("run-cancel"));
  for (const [kind, source] of [
    ["checkpoint", 'await checkpoint("hold", "Await cancellation"); await sleep("1s");'],
    ["sleep", 'await sleep("2m"); await sleep("1s");'],
  ]) {
    const started = await original.invoke("run-start", { source, file: "cancel-live.cotal.js" });
    check(`${kind}: actual start succeeds`, started.ok);
    const runId = (started.data as { runId: string }).runId;
    const deadline = performance.now() + 15_000;
    for (;;) {
      const read = await original.invoke("run-status", { runId });
      assert.equal(read.ok, true);
      const view = read.data as import("@cotal-ai/core").RunStatusView;
      if (view.journal.some(row => row.kind === "step" && row.effect === kind && row.state === "pending")) break;
      assert.ok(performance.now() < deadline, "native effect became pending");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const refused = await sibling.invoke("run-cancel", { runId, reason: "sibling cannot cancel" });
    check(`${kind}: same-owner sibling is refused`, !refused.ok && refused.error?.code === "permission-denied");
    const stillRunning = await original.invoke("run-status", { runId });
    check(`${kind}: sibling refusal leaves run running`, (stillRunning.data as import("@cotal-ai/core").RunStatusView).status?.state === "running");
    const cancelled = await original.invoke("run-cancel", { runId, reason: "native served fixture" });
    check(`${kind}: served original cancellation succeeds`, cancelled.ok);
    const receipt = cancelled.data as import("@cotal-ai/core").RunCancelResult;
    check(`${kind}: exact local drive settled released`, receipt.observed.phase === "stopped" && receipt.observed.driveOutcome?.status === "released");
    check(`${kind}: created marker attribution is actual caller`, receipt.duplicate === false && receipt.authority === "original"
      && receipt.revocation?.by === `${original.caller.owner}.${original.caller.actor}` && receipt.revocation.reason === "native served fixture");
    const after = await original.invoke("run-status", { runId });
    assert.equal(after.ok, true);
    const view = after.data as import("@cotal-ai/core").RunStatusView;
    check(`${kind}: record observes released`, view.status?.state === "released");
    const steps = view.journal.filter(row => row.kind === "step");
    check(`${kind}: no next step began`, new Set(steps.map(row => row.step)).size === 1);
    check(`${kind}: native journal settled cancellation`, steps.at(-1)?.outcome === "cancelled");
    const duplicate = await original.invoke("run-cancel", { runId, reason: "new request retains first marker" });
    const repeated = duplicate.data as import("@cotal-ai/core").RunCancelResult;
    check(`${kind}: fresh authenticated duplicate observes marker without drive`, duplicate.ok && repeated.duplicate === true
      && repeated.observed.phase === "not-driven-here" && repeated.revocation?.reason === "native served fixture");
  }
} finally {
  for (const nc of connections) await nc.drain();
  await manager?.stop();
  await delivery?.stop();
  await broker.stop();
  console.log(`owned fixture stopped; retained home=${home} workspace=${root}`);
}
assert.equal(pass, 21);
emitSentinel({ passed: pass, failed: 0 });
