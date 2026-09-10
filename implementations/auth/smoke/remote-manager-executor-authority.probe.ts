/**
 * Native verification that the minted remote-manager executor no longer carries records consumer
 * lifecycle authority. The companion host scanner probe verifies the intended sweep.
 *
 * It uses the typed manager-service issuance wrapper, mintPublicUserJwt, and credsFromJwt, then
 * drives a real authenticated broker. The expected result is three broker-enforced denials:
 * participant enumeration, durable PUSH export, and foreign durable deletion.
 *
 * Run only on an isolated owner-Linux host with nats-server on PATH:
 *   pnpm probe:remote-manager-executor-authority
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  RECORD_KINDS,
  createEndpointStreams,
  createSpaceAuth,
  credsFromJwt,
  isReachable,
  listGoalIndex,
  mintLifecycleUid,
  mintPublicUserJwt,
  newIdentity,
  recordAtomicKey,
  recordsBucket,
  recordsKvStreamName,
  remoteManagerActors,
  serverConfig,
} from "@cotal-ai/core";
import { issueRemoteManagerAuthority } from "@cotal-ai/auth";
import { openAuthorityClient } from "../src/authority-client.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { stopOwnedChild } from "./_owned-child-cleanup.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const endpoint = "manager";
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const space = `remote-exec-authority-${randomUUID().slice(0, 8)}`;
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" },
  port,
  storeDir: join(dir, "js"),
}));

let passed = 0;
let failed = 0;
const outcomes: Record<string, number> = {
  participantSweepDenied: 0,
  pushBodies: 0,
  foreignDurablesDeleted: 0,
};
const check = (name: string, condition: unknown, detail?: unknown) => {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${name}`, detail ?? "");
  }
};

const server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(server, dir);
let fixture: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let executor: NatsConnection | undefined;

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`authenticated probe broker did not start on ${port}`);

  fixture = await openAuthorityClient({
    server: servers,
    space,
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    label: `fixture:${space}`,
    grants: () => ({ publish: [">"], subscribe: [">"] }),
    log: () => {},
  });
  const fixtureJsm = await jetstreamManager(fixture.nc, { timeout: 1500 });
  await createEndpointStreams(fixtureJsm, new Kvm(fixture.nc), space);
  const records = await new Kvm(fixture.nc).open(recordsBucket(space));
  const callerUid = mintLifecycleUid();
  const managerGoalId = `goal${mintLifecycleUid()}`;
  const foreignGoalId = `goal${mintLifecycleUid()}`;
  const managerKey = recordAtomicKey(RECORD_KINDS.goalidx, [endpoint, owner, "cli", callerUid, managerGoalId]);
  const foreignKey = recordAtomicKey(RECORD_KINDS.goalidx, ["jobsrv", owner, "cli", callerUid, foreignGoalId]);
  await records.create(managerKey, enc.encode(JSON.stringify({
    v: 1, endpoint, owner, actor: "cli", uid: callerUid, goalId: managerGoalId, iid: instanceId,
  })));
  await records.create(foreignKey, enc.encode(JSON.stringify({
    v: 1, endpoint: "jobsrv", owner, actor: "cli", uid: callerUid, goalId: foreignGoalId, iid: mintLifecycleUid(),
  })));

  const identities = {
    supervisor: newIdentity(),
    executor: newIdentity(),
    serve: newIdentity(),
    goalWriter: newIdentity(),
    sessionLedger: newIdentity(),
  };
  const request = {
    v: 1 as const,
    kind: "manager-service-authority" as const,
    operation: "prepare" as const,
    space,
    actor: "cli",
    instanceId,
    managerLifecycleUid,
    requestId: `prepare${mintLifecycleUid()}`,
    identities: Object.fromEntries(Object.entries(identities).map(([name, identity]) => [name, { id: identity.id }])) as {
      supervisor: { id: string }; executor: { id: string }; serve: { id: string };
      goalWriter: { id: string }; sessionLedger: { id: string };
    },
  };
  const material = await issueRemoteManagerAuthority({
    owner,
    scope: ["supervise"],
    request,
    issue: async ({ actors }) => ({
      credentials: {
        supervisor: await mintPublicUserJwt(auth, identities.supervisor.id, "remote-manager", {
          principal: { owner, actor: actors.supervisor },
          lifecycleUid: managerLifecycleUid,
          remoteManager: { instanceId, owner, actor: actors.supervisor },
          expiresInSeconds: 24 * 60 * 60,
        }),
        executor: await mintPublicUserJwt(auth, identities.executor.id, "remote-manager", {
          principal: { owner, actor: actors.executor },
          lifecycleUid: managerLifecycleUid,
          remoteManager: { instanceId, owner, actor: actors.executor },
          expiresInSeconds: 5 * 60,
        }),
      },
    }),
  });
  assert.deepEqual(material.actors, remoteManagerActors(instanceId));
  const executorCredential = material.credentials.executor;
  assert.ok(executorCredential, "typed prepare returned no executor credential");
  const executorCreds = credsFromJwt(executorCredential.jwt, identities.executor);
  executor = await connect({
    servers,
    authenticator: credsAuthenticator(enc.encode(executorCreds)),
    inboxPrefix: `_INBOX_${identities.executor.id}`,
    maxReconnectAttempts: 0,
  });

  const execRecords = await new Kvm(executor).open(recordsBucket(space));
  try { await listGoalIndex(execRecords, endpoint); }
  catch { outcomes.participantSweepDenied = 1; }
  check("participant executor cannot enumerate manager goalidx", outcomes.participantSweepDenied === 1);

  const stream = recordsKvStreamName(space);
  const pushName = `push_${instanceId}`;
  const pushInbox = `_INBOX_${identities.executor.id}.push`;
  const pushedBodies: string[] = [];
  const pushSub = executor.subscribe(pushInbox, {
    callback: (error, message) => {
      if (!error && message) pushedBodies.push(dec.decode(message.data));
    },
  });
  await executor.flush();
  const pushFilter = `$KV.${recordsBucket(space)}.>`;
  await executor.request(
    `$JS.API.CONSUMER.CREATE.${stream}.${pushName}.${pushFilter}`,
    enc.encode(JSON.stringify({ stream_name: stream, config: {
      name: pushName, durable_name: pushName, filter_subject: pushFilter, deliver_subject: pushInbox,
      deliver_policy: "all", ack_policy: "none",
    } })), { timeout: 700 },
  ).catch(() => undefined);
  for (let i = 0; i < 30 && pushedBodies.length < 2; i++) await wait(50);
  outcomes.pushBodies = pushedBodies.length;
  check("participant executor cannot create a PUSH exporter", pushedBodies.length === 0, pushedBodies);
  let pushMissing = false;
  try { await fixtureJsm.consumers.info(stream, pushName); }
  catch (error) { pushMissing = error instanceof JetStreamApiError && error.code === JetStreamApiCodes.ConsumerNotFound; }
  check("denied PUSH create leaves no consumer", pushMissing);
  pushSub.unsubscribe();

  const foreignDurable = `foreign_${instanceId}`;
  await fixtureJsm.consumers.add(stream, {
    name: foreignDurable,
    durable_name: foreignDurable,
    filter_subject: `$KV.${recordsBucket(space)}.goalidx.jobsrv.>`,
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
  });
  const executorJsm = await jetstreamManager(executor, { timeout: 1500 });
  const deleted = await executorJsm.consumers.delete(stream, foreignDurable).catch(() => false);
  let foreignMissing = false;
  try {
    await fixtureJsm.consumers.info(stream, foreignDurable);
  } catch (error) {
    foreignMissing = error instanceof JetStreamApiError && error.code === JetStreamApiCodes.ConsumerNotFound;
  }
  outcomes.foreignDurablesDeleted = deleted && foreignMissing ? 1 : 0;
  check("participant executor cannot delete a foreign records durable", outcomes.foreignDurablesDeleted === 0 && !foreignMissing,
    { deleted, foreignMissing });

  check("all three participant records-consumer powers are absent",
    outcomes.participantSweepDenied === 1 && outcomes.pushBodies === 0 && outcomes.foreignDurablesDeleted === 0,
    outcomes);
  console.log(`REMOTE EXECUTOR AUTHORITY OUTCOMES ${JSON.stringify(outcomes)}`);
  console.log(`REMOTE EXECUTOR AUTHORITY PROBE ${failed === 0 ? "PROVED" : "FAILED"} (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
} finally {
  if (executor) await executor.drain().catch(() => executor?.close());
  if (fixture) await fixture.close().catch(() => {});
  await stopOwnedChild(server);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: release only unregisters the signal/exit cleanup backstop
}
