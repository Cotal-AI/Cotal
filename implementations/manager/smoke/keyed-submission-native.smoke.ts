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
const failures: string[] = [];
// A label names a cell whose assertions ran just above it, so it adds no count of its own.
const label = (name: string) => console.log(`PASS ${name}`);
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
  // The same triple on the legacy rail reaches both keyed handlers and is refused by name (SPEC 13.15)
  // before any binding: that submission ID then reads unbound and no run exists.
  const legacyCreds = await core.mintCreds(auth, identity, "manager-caller", {
    lifecycleUid: uid, managerInstanceId: any.responder.instanceId, capabilities: ["run"], expiresInSeconds: 300 });
  const legacyNc = await connect({ servers, ...core.standaloneConnectOpts({ creds: legacyCreds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const legacyCaller = { owner: core.DEV_OWNER, actor: identity.id, uid } as import("@cotal-ai/core").EpCaller;
    const legacy = await core.resolveService(legacyNc, space, "manager", legacyCaller, { deadlineMs: 10_000, instanceId: any.responder.instanceId });
    const legacyId = core.mintLifecycleUid();
    const named = (r: Awaited<ReturnType<typeof core.invokeCommand>>) => {
      const details = r.reply.error?.details as { kind?: string; owner?: string; actor?: string; uid?: string }[] | undefined;
      return r.reply.ok === false && r.reply.error?.code === "permission-denied" && details?.length === 1
        && details[0]!.kind === core.EP_UNBOUND_CALLER_AUTHORITY && details[0]!.owner === core.DEV_OWNER
        && details[0]!.actor === identity.id && details[0]!.uid === uid;
    };
    check("legacy-rail run-start-keyed refused with the unbound-caller-authority detail naming the triple",
      named(await core.invokeCommand(legacyNc, space, legacy, "run-start-keyed", args, { id: legacyId, deadlineMs: 5000 })));
    check("legacy-rail run-submission-status refused with the unbound-caller-authority detail naming the triple",
      named(await core.invokeCommand(legacyNc, space, legacy, "run-submission-status", { submissionId: legacyId }, { deadlineMs: 5000 })));
    const unbound = (await core.readKeyedRunSubmission(nc, space, prepare(legacyId), { deadlineMs: 5000 })).state === "unbound";
    const runs = await core.invokeCommand(nc, space, service, "run-ps", {}, { deadlineMs: 5000 });
    check("legacy-rail keyed refusal binds nothing and starts no run", unbound && runs.reply.ok && JSON.stringify(runs.reply.data) === "[]");
  } finally { await legacyNc.close(); }
  const submission = prepare();
  const races = await Promise.all(Array.from({ length: 5 }, () => core.invokeKeyedRunSubmission(nc!, space, submission, { deadlineMs: 30_000 })));
  const first = races[0]!.runId!, second = races.at(-1)!.runId!;
  check("same-key native concurrent duplicate binds exactly one run", new Set(races.map(r => r.runId)).size === 1);
  assert.equal((await core.readKeyedRunSubmission(nc, space, submission, { deadlineMs: 5000 })).runId, first);
  label("native exact caller submission read retains original binding");
  const conflict = await core.invokeCommand(nc, space, service, "run-start-keyed", { ...args, source: 'log("changed");' }, { id: submission.submissionId, deadlineMs: 5000 });
  check("native same-key changed fingerprint refused", conflict.reply.ok === false && conflict.reply.error?.code === "conflict");
  const old = { ...service, commands: new Map(service.commands) }; old.commands.delete("run-start-keyed");
  assert.throws(() => core.prepareKeyedRunSubmission(space, old, core.mintLifecycleUid(), args), /distinct contracts/);
  label("unsupported old described surface refuses before keyed publish, no legacy fallback");
  const wrongEpoch = { ...service, responder: { ...service.responder, epoch: service.responder.epoch + 1 } };
  const epochSubmission = prepare();
  await assert.rejects(core.invokeCommand(nc, space, wrongEpoch, "run-start-keyed", args, { id: epochSubmission.submissionId, deadlineMs: 5000 }),
    error => core.respondedButUnbound(error));
  assert.equal((await core.readKeyedRunSubmission(nc, space, epochSubmission, { deadlineMs: 5000 })).state, "unbound");
  label("wrong epoch reply rejected, exact healthy-epoch read independently observes unbound");
  // Drop one actual native reply at the caller subscription, after broker delivery. Preserve its
  // decoded payload only as the oracle. This is local transport injection, not a network outage.
  const lost = prepare(), subscribe = nc.subscribe;
  let dropped = false, originalRun: string | undefined;
  nc.subscribe = ((subject: string, opts: any) => subscribe.call(nc!, subject, opts?.callback ? { ...opts, callback: (error: unknown, msg: any) => {
    if (!error && msg?.data) {
      try { const reply = JSON.parse(new TextDecoder().decode(msg.data));
        if (reply.id === lost.submissionId && reply.ok === true) { dropped = true; originalRun = reply.data.runId; return; }
      } catch { /* preserve ordinary callback handling for non-JSON */ }
    }
    return opts.callback(error, msg);
  } } : opts)) as typeof nc.subscribe;
  try { await assert.rejects(core.invokeKeyedRunSubmission(nc, space, lost, { deadlineMs: 8000 }), /within|deadline|reply/i); }
  finally { nc.subscribe = subscribe; }
  const recovered = await core.invokeKeyedRunSubmission(nc, space, lost, { deadlineMs: 5000 });
  check("actually suppressed first reply retries same ID to original run", dropped && !!originalRun && recovered.runId === originalRun);
  console.log(JSON.stringify({ submissionId: submission.submissionId, firstRunId: first, retryRunId: second, suppressedReplyRun: originalRun,
    scope: "static-auth native manager; locally suppressed reply, not signerless/Cloud/webhook acceptance" }));
  for (const runId of new Set([first, second, recovered.runId!])) {
    let completed = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await core.invokeCommand(nc, space, service, "run-status", { runId }, { deadlineMs: 5000 });
      assert.equal(result.reply.ok, true);
      if ((result.reply.data as { status?: { state: string } }).status?.state === "completed") { completed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(`accepted run ${runId} completes without seats`, completed);
  }
} finally {
  const cleanupErrors: unknown[] = [];
  for (const stop of [() => nc?.close(), () => manager?.stop(), () => delivery?.stop(), () => killAndAwaitExit(broker)]) {
    try { await stop(); } catch (error) { cleanupErrors.push(error); }
  }
  releaseBroker();
  console.log(JSON.stringify({ cleanup: cleanupErrors.length === 0 ? "complete" : "failed", brokerExitCode: broker.exitCode, brokerSignal: broker.signalCode, retainedScratch: [home, root, store] }));
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "owned fixture cleanup failed");
}
if (failures.length) process.exitCode = 1;
emitSentinel({ passed: counted.cells() + checked - failures.length, failed: failures.length });
