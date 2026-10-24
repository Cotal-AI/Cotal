/** Keyed static-auth native manager acceptance. Owned broker and harmless seatless runs only. */
import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { freePort, SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal, countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const home = mkdtempSync(join(tmpdir(), "cotal-submission-home-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";

const core = await import("@cotal-ai/core");
const workspace = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
await import("@cotal-ai/runtime");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const space = `submission${core.mintLifecycleUid().slice(0, 8)}`;
const auth = await core.createSpaceAuth(space);
const root = mkdtempSync(join(tmpdir(), "cotal-submission-project-"));
mkdirSync(join(root, ".cotal"));
workspace.saveSpaceAuth(workspace.authDir(root), auth);
const port = process.env.KEYED_BROKER_PORT ? Number(process.env.KEYED_BROKER_PORT) : await freePort();
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, "owned loopback broker port");
const servers = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(store, "server.conf"), core.serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, host: "127.0.0.1", port, storeDir: join(store, "js"),
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(store, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker);
let manager: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let longNc: Awaited<ReturnType<typeof connect>> | undefined;
const failures: string[] = [];
let checked = 0;
const check = (name: string, ok: boolean) => {
  checked++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures.push(name);
};
try {
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  assert.equal(broker.exitCode, null, "the owned broker must hold the listener");
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  workspace.recordMesh({ space, server: servers, root, mode: "auth", ts: new Date().toISOString() });
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspace.workspaceSecretStore(root).identity });
  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root });
  await manager.start();
  const identity = core.newIdentity();
  const uid = core.mintLifecycleUid();
  const issued = { generation: core.mintGeneration(), acceptedToken: core.mintAcceptedToken() };
  const caller = { owner: core.DEV_OWNER, actor: identity.id, uid, generation: issued.generation } as import("@cotal-ai/core").EpCaller;
  const creds = await core.withIssuerSession({ servers, space, auth, tls: false }, (session) => core.mintCreds(auth, identity, "agent", {
    lifecycleUid: uid, capabilities: ["run"], expiresInSeconds: 300, issued,
    issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] },
  }));
  nc = await connect({ servers, ...core.standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const any = await core.resolveService(nc, space, "manager", caller, { deadlineMs: 10_000 });
  await nc.close();
  const pinnedIssued = { generation: core.mintGeneration(), acceptedToken: core.mintAcceptedToken() };
  Object.assign(caller, { generation: pinnedIssued.generation });
  const pinnedCreds = await core.withIssuerSession({ servers, space, auth, tls: false }, (session) => core.mintCreds(auth, identity, "manager-caller", {
    lifecycleUid: uid, managerInstanceId: any.responder.instanceId, capabilities: ["run"], expiresInSeconds: 300, issued: pinnedIssued,
    issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] },
  }));
  nc = await connect({ servers, ...core.standaloneConnectOpts({ creds: pinnedCreds, tls: false }), maxReconnectAttempts: 0 });
  const service = await core.resolveService(nc, space, "manager", caller, { deadlineMs: 10_000, instanceId: any.responder.instanceId });
  const args = { source: 'log("keyed submission native");', file: "submission.cotal.js" };
  const prepare = (id = core.mintLifecycleUid()) => core.prepareKeyedRunSubmission(space, service, id, args);
  // K4 entry: epCall bounds a budget to the timer range, but an issued caller may publish its own
  // envelope, so the receiver alone bounds deadlineMs. Each leg reads the exact submission after.
  const rawKeyed = async (conn: NonNullable<typeof nc>, svc: typeof service, who: import("@cotal-ai/core").EpCaller, deadlineMs: number) => {
    const command = svc.commands.get("run-start-keyed")!, id = core.mintLifecycleUid(), nonce = core.mintLifecycleUid();
    const instanceId = svc.responder.instanceId, epoch = svc.responder.epoch;
    const sub = conn.subscribe(core.epReplySubject(space, { endpoint: "manager", instanceId, epoch, caller: who, nonce }), { max: 1, timeout: 20_000 });
    conn.publish(core.epRequestSubject(space, { route: { mode: "inst", instanceId }, endpoint: "manager", command: "run-start-keyed", caller: who, nonce }),
      new TextEncoder().encode(JSON.stringify({ v: 1, id, class: "ephemeral", replyExpected: true, deadlineMs,
        op: { endpoint: "manager", command: "run-start-keyed", inputDigest: command.contract.input.closureDigest, outputDigest: command.contract.output.closureDigest },
        bind: { instanceId, epoch }, from: { id: `${who.owner}.${who.actor}`, name: who.actor }, args })));
    let reply: { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
    try { for await (const m of sub) reply = JSON.parse(new TextDecoder().decode(m.data)); } catch (error) { reply = { error: { message: String(error) } }; }
    const view = await core.readKeyedRunSubmission(conn, space, core.prepareKeyedRunSubmission(space, svc, id, args), { deadlineMs: 10_000 });
    return { deadlineMs, ok: reply?.ok, code: reply?.error?.code, message: reply?.error?.message, state: view.state, runId: view.runId };
  };
  const overBudget = await rawKeyed(nc, service, caller, 600_000);
  const overTimer = await rawKeyed(nc, service, caller, 2_147_483_648 + 10_000);
  const longIssued = { generation: core.mintGeneration(), acceptedToken: core.mintAcceptedToken() };
  const longCaller = { ...caller, generation: longIssued.generation } as import("@cotal-ai/core").EpCaller;
  let farExpiry: unknown;
  try {
    const longCreds = await core.withIssuerSession({ servers, space, auth, tls: false }, (session) => core.mintCreds(auth, identity, "manager-caller", {
      lifecycleUid: uid, managerInstanceId: any.responder.instanceId, capabilities: ["run"], expiresInSeconds: 30 * 86_400, issued: longIssued,
      issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] },
    }));
    longNc = await connect({ servers, ...core.standaloneConnectOpts({ creds: longCreds, tls: false }), maxReconnectAttempts: 0 });
    const longService = await core.resolveService(longNc, space, "manager", longCaller, { deadlineMs: 10_000, instanceId: any.responder.instanceId });
    farExpiry = await rawKeyed(longNc, longService, longCaller, 2_147_483_648 + 10_000);
  } catch (error) { farExpiry = { unreached: String(error) }; }
  console.log(JSON.stringify({ cell: "K4-entry-raw-envelope", overBudget, overTimer, farExpiry, budgetMs: 30_000,
    scope: "actual static native manager, actual issued pinned callers (300s and 30d evidence), raw envelope on the inst rail" }));
  const refusedUnbound = (leg: unknown) => (leg as { ok?: boolean; code?: string; state?: string }).ok === false
    && (leg as { code?: string }).code === "bad-request" && (leg as { state?: string }).state === "unbound";
  check("keyed deadline over the request budget refuses before any binding", refusedUnbound(overBudget));
  check("keyed deadline over the timer range refuses before any binding", refusedUnbound(overTimer));
  check("far-expiry caller over the timer range refuses as bad-request, not an unknown outcome", refusedUnbound(farExpiry));
  // Clock controls at the entry: a 1ms budget is spent on this manager's monotonic clock before the
  // bind, and a budget within range still binds and starts.
  const spent = await rawKeyed(nc, service, caller, 1);
  const inBudget = await rawKeyed(nc, service, caller, 30_000);
  console.log(JSON.stringify({ cell: "K4d-entry-monotonic-budget", spent, inBudget,
    scope: "actual static native manager, actual issued pinned caller, raw envelope on the inst rail" }));
  check("a request budget spent before the bind refuses as deadline-exceeded and binds nothing",
    spent.ok === false && spent.code === "deadline-exceeded" && spent.state === "unbound");
  check("a request within the budget binds and starts", inBudget.ok === true && inBudget.state === "activated");
  const { jetstreamManager } = await import("@nats-io/jetstream");
  const { Kvm } = await import("@nats-io/kv");
  const probeId = core.newIdentity(), runId = core.newSubmissionRunId();
  const probeCreds = await core.mintCreds(auth, probeId, "run-admitter", { runAdmitter: { endpoint: "manager", runId }, expiresInSeconds: 60 });
  const probe = await connect({ servers, ...core.standaloneConnectOpts({ creds: probeCreds, tls: false }), reconnect: false });
  try {
    const jsm = await jetstreamManager(probe), kv = await new Kvm(probe).open(core.admissionBucket(space));
    const admission: import("@cotal-ai/core").RunAdmission = { version: 1, space, endpoint: "manager", runId,
      instanceId: service.responder.instanceId, caller, admittedAt: Date.now(),
      provenance: { kind: "issued", ref: { space, ...caller, generation: pinnedIssued.generation }, resolvedRevision: 1 },
      ceiling: { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } } };
    const started = performance.now(), warnings: string[] = [];
    const onWarning = (warning: Error) => { warnings.push(warning.name + ": " + warning.message); };
    process.on("warning", onWarning);
    let timerError: { message: string; code?: string } | undefined, asserted = false;
    const timerSubmission = core.mintLifecycleUid();
    try { await core.bindAndAdmitRunSubmission({ kv, jsm, admission, submissionId: timerSubmission,
      fingerprint: core.contractDigest({ timer: true }), processEpoch: service.responder.epoch,
      deadline: { requestEndsAt: performance.now() + 2_147_483_648 + 10_000 },
      assertCurrent: () => { asserted = true; return new Promise(resolve => setTimeout(resolve, 25)); } }); }
    catch (error) { timerError = { message: String(error), code: (error as any).code }; }
    finally { process.off("warning", onWarning); }
    const timerBinding = await core.readSubmissionRecord(jsm, space, core.runSubmissionKey("manager", caller, timerSubmission));
    console.log(JSON.stringify({ cell: "K4-actual-overflow", elapsedMs: performance.now() - started, warnings, timerError, asserted,
      bindingPresent: timerBinding !== undefined,
      scope: "actual bind function and Node timer, assertCurrent deliberately delayed25ms, actual owned broker" }));
    check("exported bind refuses an over-budget callback deadline before any read or effect",
      timerError?.code === "bad-request" && !asserted && timerBinding === undefined);
    let closed: unknown;
    void probe.closed().then(error => { closed = String(error); });
    await new Promise(resolve => setTimeout(resolve, 63_000));
    let afterExpiry: unknown;
    try { await probe.flush(); afterExpiry = "flush-success"; } catch (error) { afterExpiry = String(error); }
    console.log(JSON.stringify({ cell: "K4-actual-60s-run-admitter", elapsedMs: performance.now() - started,
      closed, isClosed: probe.isClosed(), afterExpiry, scope: "actual minted run-admitter profile60s, no expiry override" }));
    check("overflow timer does not masquerade as expired original deadline", warnings.length === 0);
    check("actual run-admitter60s credential broker disconnect", probe.isClosed());
  } finally { await probe.close(); }

} finally {
  const cleanupErrors: unknown[] = [];
  for (const stop of [() => nc?.close(), () => longNc?.close(), () => manager?.stop({ withAgents: true }), () => delivery?.stop(), () => killAndAwaitExit(broker)]) {
    try { await stop(); } catch (error) { cleanupErrors.push(error); }
  }
  releaseBroker();
  console.log(JSON.stringify({ cleanup: cleanupErrors.length === 0 ? "complete" : "failed", brokerExitCode: broker.exitCode, brokerSignal: broker.signalCode, retainedScratch: [home, root, store] }));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "owned fixture cleanup failed");
}
if (failures.length) process.exitCode = 1;
emitSentinel({ passed: counted.cells() + checked - failures.length, failed: failures.length });
