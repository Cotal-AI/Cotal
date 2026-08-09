/**
 * Live NATS 2.10-compatible snapshot/restore and maintenance-permission smoke.
 * Run: pnpm --filter @cotal-ai/core smoke:backup:live
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  anycastSubject,
  canonicalBackupStreamConfig,
  chatStream,
  chatSubject,
  createSpaceAuth,
  dmStream,
  downloadStreamSnapshot,
  fanoutDurableConfig,
  finalizeStreamRestore,
  initiateStreamRestore,
  inspectCredHealth,
  isReachable,
  mintCreds,
  newIdentity,
  recreateConsumerCheckpoint,
  serverConfig,
  setupSpaceStreams,
  spaceBackupInventory,
  standaloneConnectOpts,
  taskDurableConfig,
  taskStream,
  uploadStreamRestoreChunk,
  validateCanonicalBackupStreamConfig,
  validatePersistentConsumerInventory,
} from "../src/index.js";

const PORT = 12000 + Math.floor(Math.random() * 8000);
const servers = `nats://127.0.0.1:${PORT}`;
const space = `backup_${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-backup-live-"));
const auth = await createSpaceAuth(space);
const configPath = join(dir, "server.conf");
writeFileSync(configPath, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const server = spawn("nats-server", ["-c", configPath], { stdio: "ignore" });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const awaitExit = (timeoutMs = 3000): Promise<void> => new Promise((resolve) => {
  if (server.exitCode !== null || server.signalCode !== null) return resolve();
  server.once("exit", () => resolve());
  setTimeout(resolve, timeoutMs);
});

async function requestPermission(
  creds: string,
  id: string,
  subject: string,
  payload: Uint8Array | string = new Uint8Array(0),
): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers,
    ...standaloneConnectOpts({ creds }),
    maxReconnectAttempts: 0,
  });
  try {
    await nc.request(subject, payload, { timeout: 500 });
    return "allowed";
  } catch (cause) {
    const message = (cause as Error).message;
    return /authorization|permission/i.test(message) ? "denied" : "allowed";
  } finally {
    await nc.drain().catch(() => {});
  }
}

try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) { ready = true; break; }
    await wait(100);
  }
  if (!ready) throw new Error(`nats-server did not start on ${PORT}`);

  const provisioner = newIdentity();
  const provisionerCreds = await mintCreds(auth, provisioner, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });

  const operator = newIdentity();
  const operatorCreds = await mintCreds(auth, operator, "operator");
  const operatorNc = await connect({ servers, ...standaloneConnectOpts({ creds: operatorCreds }) });
  const snapshotPayload = randomBytes(768 * 1024);
  await jetstream(operatorNc).publish(
    chatSubject(space, "local", operator.id, "general"),
    snapshotPayload,
    { msgID: "backup-message" },
  );
  await jetstream(operatorNc).publish(
    anycastSubject(space, "worker", "local", operator.id),
    JSON.stringify({ id: "backup-task", value: "preserved" }),
    { msgID: "backup-task" },
  );
  await operatorNc.drain();

  // `DeliverPolicy.New` must retain its creation frontier even before the first pull/delivery.
  const delivery = newIdentity();
  const deliveryCreds = await mintCreds(auth, delivery, "delivery");
  const deliveryNc = await connect({ servers, ...standaloneConnectOpts({ creds: deliveryCreds }) });
  const deliveryManager = await jetstreamManager(deliveryNc);
  const fanout = await deliveryManager.consumers.add(chatStream(space), fanoutDurableConfig(space));
  const taskProvisionerNc = await connect({ servers, ...standaloneConnectOpts({ creds: provisionerCreds }) });
  const taskProvisionerManager = await jetstreamManager(taskProvisionerNc);
  const task = await taskProvisionerManager.consumers.add(taskStream(space), taskDurableConfig(space, "worker"));
  const consumersByStream = Object.fromEntries(spaceBackupInventory(space).full.map((stream) => [stream, []]));
  consumersByStream[chatStream(space)] = [fanout];
  consumersByStream[taskStream(space)] = [task];
  const streamStates = Object.fromEntries(await Promise.all(spaceBackupInventory(space).full.map(async (stream) => [
    stream,
    (await taskProvisionerManager.streams.info(stream)).state,
  ])));
  const extractedCheckpoints = validatePersistentConsumerInventory(space, consumersByStream, streamStates);
  const fanoutCheckpoint = extractedCheckpoints.find((checkpoint) => checkpoint.name === "fanout")!;
  const taskCheckpoint = extractedCheckpoints.find((checkpoint) => checkpoint.name === "svc_worker")!;
  assert.equal(fanoutCheckpoint.creationLowerBound, 2, "zero-delivery New consumer preserves its creation frontier");
  assert.equal(taskCheckpoint.creationLowerBound, 1, "TASK checkpoint retains canonical DeliverAll lower bound");
  await taskProvisionerNc.drain();
  await deliveryNc.drain();

  const inventory = spaceBackupInventory(space);
  const backupInspector = newIdentity();
  const backupInspectorCreds = await mintCreds(auth, backupInspector, "backup", {
    backup: { operation: "inspect", selection: "registry" },
  });
  assert.equal(
    await requestPermission(backupInspectorCreds, backupInspector.id, "$JS.API.STREAM.NAMES", "{}"),
    "allowed",
    "backup inspector can list stream names",
  );
  assert.equal(
    await requestPermission(backupInspectorCreds, backupInspector.id, `$JS.API.STREAM.INFO.${inventory.registry[0]}`),
    "allowed",
    "backup inspector can inspect a selected stream",
  );
  assert.equal(
    await requestPermission(backupInspectorCreds, backupInspector.id, `$JS.API.CONSUMER.LIST.${inventory.registry[0]}`, "{}"),
    "allowed",
    "backup inspector can list consumers for a selected stream",
  );
  assert.equal(
    await requestPermission(backupInspectorCreds, backupInspector.id, `$JS.API.STREAM.INFO.${chatStream(space)}`),
    "denied",
    "registry inspector cannot inspect an unselected canonical stream",
  );
  assert.equal(
    await requestPermission(backupInspectorCreds, backupInspector.id, `$JS.API.STREAM.MSG.GET.${inventory.registry[0]}`, "{}"),
    "denied",
    "backup inspector has no message GET",
  );

  const backup = newIdentity();
  const snapshotSubject = `_INBOX_${backup.id}.snapshot.${randomUUID().replace(/-/g, "")}`;
  const backupCreds = await mintCreds(auth, backup, "backup", {
    backup: { operation: "snapshot", stream: chatStream(space), deliverSubject: snapshotSubject },
  });
  assert.equal(inspectCredHealth(backupCreds).state, "healthy");
  const backupNc = await connect({ servers, ...standaloneConnectOpts({ creds: backupCreds }) });
  const chunks: Uint8Array[] = [];
  const snapshot = await downloadStreamSnapshot(backupNc, chatStream(space), {
    deliverSubject: snapshotSubject,
    onChunk: (chunk) => chunks.push(chunk),
  });
  validateCanonicalBackupStreamConfig(space, chatStream(space), snapshot.config);
  assert.ok(chunks.length >= 3, "snapshot payload spans multiple native chunks");
  assert.ok(chunks.reduce((bytes, chunk) => bytes + chunk.length, 0) > snapshotPayload.length);
  assert.equal(snapshot.state.messages, 1);
  await backupNc.drain();

  assert.equal(
    await requestPermission(backupCreds, backup.id, `$JS.API.STREAM.SNAPSHOT.${dmStream(space)}`),
    "denied",
    "backup is cross-stream denied",
  );
  assert.equal(
    await requestPermission(backupCreds, backup.id, `$JS.API.STREAM.RESTORE.${chatStream(space)}`),
    "denied",
    "backup cannot restore",
  );
  assert.equal(
    await requestPermission(backupCreds, backup.id, `$JS.SNAPSHOT.ACK.${chatStream(space)}.wrong`),
    "denied",
    "backup cannot publish a guessed snapshot ACK id",
  );
  assert.equal(
    await requestPermission(
      provisionerCreds,
      provisioner.id,
      `$JS.API.STREAM.SNAPSHOT.${chatStream(space)}`,
      JSON.stringify({ deliver_subject: `_INBOX_${provisioner.id}.snapshot`, no_consumers: true }),
    ),
    "denied",
    "ordinary provisioner cannot snapshot",
  );
  assert.equal(
    await requestPermission(provisionerCreds, provisioner.id, `$JS.API.STREAM.RESTORE.${chatStream(space)}`),
    "denied",
    "ordinary provisioner cannot restore",
  );

  const teardown = newIdentity();
  const teardownCreds = await mintCreds(auth, teardown, "teardown");
  const teardownNc = await connect({ servers, ...standaloneConnectOpts({ creds: teardownCreds }) });
  const teardownManager = await jetstreamManager(teardownNc);
  await teardownManager.streams.delete(taskStream(space));
  await teardownManager.streams.delete(chatStream(space));
  await teardownNc.drain();

  const taskStreamCreatorNc = await connect({ servers, ...standaloneConnectOpts({ creds: provisionerCreds }) });
  await (await jetstreamManager(taskStreamCreatorNc)).streams.add(canonicalBackupStreamConfig(space, taskStream(space)));
  await taskStreamCreatorNc.drain();

  const restoreInit = newIdentity();
  const restoreInitCreds = await mintCreds(auth, restoreInit, "restore", {
    restore: { operation: "initiate", stream: chatStream(space) },
  });
  assert.equal(inspectCredHealth(restoreInitCreds).state, "healthy");
  const restoreInitNc = await connect({ servers, ...standaloneConnectOpts({ creds: restoreInitCreds }) });
  const session = await initiateStreamRestore(
    restoreInitNc,
    space,
    chatStream(space),
    canonicalBackupStreamConfig(space, chatStream(space)),
    snapshot.state,
  );
  await restoreInitNc.drain();

  const restoreUpload = newIdentity();
  const restoreUploadCreds = await mintCreds(auth, restoreUpload, "restore", {
    restore: { operation: "upload", stream: chatStream(space), deliverSubject: session.deliverSubject },
  });
  const wrongId = `${session.deliverSubject}wrong`;
  assert.equal(
    await requestPermission(restoreUploadCreds, restoreUpload.id, wrongId, new Uint8Array([1])),
    "denied",
    "restore upload is wrong-ID denied",
  );
  assert.equal(
    await requestPermission(
      restoreUploadCreds,
      restoreUpload.id,
      `$JS.SNAPSHOT.RESTORE.${dmStream(space)}.wrong`,
      new Uint8Array([1]),
    ),
    "denied",
    "restore upload is cross-stream denied",
  );

  const restoreUploadNc = await connect({ servers, ...standaloneConnectOpts({ creds: restoreUploadCreds }) });
  for (const chunk of chunks) await uploadStreamRestoreChunk(restoreUploadNc, session, chunk);
  const restored = await finalizeStreamRestore(restoreUploadNc, session);
  await restoreUploadNc.drain();
  validateCanonicalBackupStreamConfig(space, chatStream(space), restored.config);
  assert.equal(restored.state.messages, 1);

  const restoreValidator = newIdentity();
  const restoreValidatorCreds = await mintCreds(auth, restoreValidator, "restore", {
    restore: { operation: "validate", stream: chatStream(space) },
  });
  const validateNc = await connect({ servers, ...standaloneConnectOpts({ creds: restoreValidatorCreds }) });
  const infoResponse = JSON.parse((await validateNc.request(`$JS.API.STREAM.INFO.${chatStream(space)}`, "{}", { timeout: 1000 })).string());
  assert.equal(infoResponse.state.messages, 1, "restore validator sees restored message state");
  assert.equal(infoResponse.state.consumer_count, 0, "no native consumer survives no_consumers snapshot/restore");
  await validateNc.drain();
  assert.equal(
    await requestPermission(restoreValidatorCreds, restoreValidator.id, `$JS.API.STREAM.INFO.${dmStream(space)}`),
    "denied",
    "restore validator cannot inspect another stream",
  );
  assert.equal(
    await requestPermission(restoreValidatorCreds, restoreValidator.id, `$JS.API.STREAM.MSG.GET.${chatStream(space)}`, "{}"),
    "denied",
    "restore validator has no message GET",
  );

  const checkpointWriter = newIdentity();
  const checkpointCreds = await mintCreds(auth, checkpointWriter, "restore", {
    restore: { operation: "checkpoint", checkpoint: fanoutCheckpoint },
  });
  const checkpointNc = await connect({ servers, ...standaloneConnectOpts({ creds: checkpointCreds }) });
  const recreated = await recreateConsumerCheckpoint(checkpointNc, space, fanoutCheckpoint);
  assert.equal(recreated.name, fanoutCheckpoint.name);
  assert.equal(recreated.config.opt_start_seq, 2, "checkpoint recreates at the conservative start sequence");
  await checkpointNc.drain();

  const taskCheckpointWriter = newIdentity();
  const taskCheckpointCreds = await mintCreds(auth, taskCheckpointWriter, "restore", {
    restore: { operation: "checkpoint", checkpoint: taskCheckpoint },
  });
  const taskCheckpointNc = await connect({ servers, ...standaloneConnectOpts({ creds: taskCheckpointCreds }) });
  const recreatedTask = await recreateConsumerCheckpoint(taskCheckpointNc, space, taskCheckpoint);
  assert.equal(recreatedTask.name, taskCheckpoint.name);
  assert.equal(recreatedTask.config.deliver_policy, "all", "TASK checkpoint recreates with WorkQueue DeliverAll");
  assert.equal(recreatedTask.config.opt_start_seq, undefined, "TASK checkpoint has no start-sequence override");
  await taskCheckpointNc.drain();
  assert.equal(
    await requestPermission(
      checkpointCreds,
      checkpointWriter.id,
      `$JS.API.CONSUMER.INFO.${chatStream(space)}.${fanoutCheckpoint.name}`,
    ),
    "allowed",
    "checkpoint credential can inspect its exact durable",
  );
  assert.equal(
    await requestPermission(checkpointCreds, checkpointWriter.id, `$JS.API.CONSUMER.INFO.${chatStream(space)}.reader`),
    "denied",
    "checkpoint credential cannot inspect another durable",
  );
  assert.equal(
    await requestPermission(checkpointCreds, checkpointWriter.id, `$JS.API.CONSUMER.INFO.${dmStream(space)}.${fanoutCheckpoint.name}`),
    "denied",
    "checkpoint credential cannot inspect another stream",
  );
  assert.equal(
    await requestPermission(checkpointCreds, checkpointWriter.id, `$JS.API.CONSUMER.MSG.NEXT.${chatStream(space)}.${fanoutCheckpoint.name}`, "1"),
    "denied",
    "checkpoint credential cannot read consumer bodies",
  );
  assert.equal(
    await requestPermission(checkpointCreds, checkpointWriter.id, `$JS.API.STREAM.MSG.GET.${chatStream(space)}`, "{}"),
    "denied",
    "checkpoint credential cannot direct-read stream bodies",
  );
  assert.equal(
    await requestPermission(
      provisionerCreds,
      provisioner.id,
      `$JS.API.CONSUMER.CREATE.${chatStream(space)}.fanout.${fanoutDurableConfig(space).filter_subject}`,
      "{}",
    ),
    "denied",
    "ordinary provisioner did not gain CHAT checkpoint creation",
  );

  console.log("backup live smoke: snapshot/restore and permission matrix passed");
} finally {
  server.kill("SIGTERM");
  await awaitExit();
  rmSync(dir, { recursive: true, force: true });
}
