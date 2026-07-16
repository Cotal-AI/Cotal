/** Hermetic CLI backup artifact and maintenance-grammar smoke. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { createArtifactWriter, stageArtifact } from "../src/lib/backup-artifact.js";
import { down } from "../src/commands/down.js";
import { backupComplete, chunkQueue, isStoppedKvWatcher } from "../src/commands/backup.js";
import { upComplete } from "../src/commands/up.js";
import { ensurePrivateAttemptsDir } from "../src/lib/isolated-broker.js";
import { isManagerCommitResult, isManagerFinalizeResult } from "../src/lib/restore.js";
import { authorityFingerprint } from "../src/lib/maintenance-files.js";
import { assertEndpointUnreachable } from "../src/lib/endpoint-cut.js";
import { consumerConfigFromCheckpoint, createSpaceAuth, dmStream, rotateSystemAccount, taskStream } from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { DeliverPolicy, type ConsumerInfo } from "@nats-io/jetstream";

const root = mkdtempSync(join(tmpdir(), "cotal-backup-cli-"));
try {
  const destination = join(root, "artifact");
  const writer = createArtifactWriter(destination);
  const snapshot = await writer.writeFile("stream-a.snap", "snapshot", new Uint8Array([1, 2, 3]), "CHAT_demo");
  const checkpoints = await writer.writeFile("checkpoints.json", "checkpoints", "[]\n");
  writer.publish({
    space: "demo",
    selection: "registry",
    mode: "open",
    source: { path: join(root, "source"), dev: "1", ino: "2", generation: "00000000-0000-4000-8000-000000000000" },
    streams: [{
      stream: "CHAT_demo",
      snapshot: snapshot.path,
      config: {},
      state: { messages: 0, bytes: 0, first_seq: 0, last_seq: 0, consumer_count: 0 },
    }],
    checkpoints: checkpoints.path,
  }, [snapshot, checkpoints]);
  assert.equal(statSync(destination).mode & 0o777, 0o700);
  for (const file of ["stream-a.snap", "checkpoints.json", "manifest.json"])
    assert.equal(statSync(join(destination, file)).mode & 0o777, 0o600, `${file} is private`);
  assert.throws(() => createArtifactWriter(destination), /already exists/);
  const originalManifest = readFileSync(join(destination, "manifest.json"), "utf8");

  const stagingParent = join(root, "staging");
  mkdirSync(stagingParent, { mode: 0o700 });
  const staged = stageArtifact(destination, stagingParent);
  assert.deepEqual(readFileSync(join(staged.directory, "stream-a.snap")), Buffer.from([1, 2, 3]));
  staged.cleanup();

  writeFileSync(join(destination, "extra"), "x");
  assert.throws(() => stageArtifact(destination, stagingParent), /extra, duplicate, or missing/);
  rmSync(join(destination, "extra"));
  writeFileSync(join(destination, "stream-a.snap"), "changed");
  assert.throws(() => stageArtifact(destination, stagingParent), /grew while staging|size or SHA-256 mismatch/);
  writeFileSync(join(destination, "stream-a.snap"), Buffer.from([1, 2, 3]));
  const traversing = JSON.parse(originalManifest) as { checkpoints: string };
  traversing.checkpoints = "../checkpoints.json";
  writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(traversing)}\n`);
  assert.throws(() => stageArtifact(destination, stagingParent), /invalid backup artifact file name/);
  writeFileSync(join(destination, "manifest.json"), originalManifest);
  if (process.platform !== "win32") {
    const external = join(root, "external.snap");
    writeFileSync(external, Buffer.from([1, 2, 3]));
    rmSync(join(destination, "stream-a.snap"));
    symlinkSync(external, join(destination, "stream-a.snap"));
    assert.throws(() => stageArtifact(destination, stagingParent), /not a real file/);
    rmSync(join(destination, "stream-a.snap"));
    writeFileSync(join(destination, "stream-a.snap"), Buffer.from([1, 2, 3]));

    const redirectedRoot = join(root, "redirected-root");
    const redirected = join(root, "redirected-maintenance");
    mkdirSync(redirectedRoot);
    mkdirSync(redirected);
    symlinkSync(redirected, join(redirectedRoot, ".cotal"));
    assert.throws(() => ensurePrivateAttemptsDir(redirectedRoot), /not a real directory/);
  }

  const queue = chunkQueue();
  const iterator = queue.iterable[Symbol.asyncIterator]();
  const waiting = iterator.next();
  let accepted = false;
  const pushed = queue.push(new Uint8Array([9])).then(() => { accepted = true; });
  assert.deepEqual((await waiting).value, new Uint8Array([9]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, false, "snapshot chunk is not accepted before the sink asks for the next chunk");
  const finished = iterator.next();
  await pushed;
  queue.close();
  assert.equal((await finished).done, true);

  const watcher = {
    name: "oc_test",
    push_bound: false,
    config: {
      name: "oc_test",
      deliver_policy: "last_per_subject",
      ack_policy: "none",
      max_deliver: 1,
      filter_subject: "$KV.bucket.>",
      replay_policy: "instant",
      flow_control: true,
      deliver_subject: "_INBOX_test",
      idle_heartbeat: 30_000_000_000,
      inactive_threshold: 300_000_000_000,
      num_replicas: 1,
      metadata: { "_nats.req.level": "0" },
    },
  } as unknown as ConsumerInfo;
  assert.equal(isStoppedKvWatcher("KV_bucket", watcher), true);
  assert.equal(isStoppedKvWatcher("KV_bucket", {
    ...watcher,
    config: {
      ...watcher.config,
      max_deliver: -1,
      headers_only: true,
      idle_heartbeat: 5_000_000_000,
      inactive_threshold: undefined,
      num_replicas: 0,
    },
  }), true);
  assert.equal(isStoppedKvWatcher("KV_bucket", { ...watcher, push_bound: true }), false);
  assert.equal(isStoppedKvWatcher("KV_bucket", {
    ...watcher,
    config: { ...watcher.config, inactive_threshold: 1 },
  }), false);

  await assert.rejects(
    () => down({ positionals: ["nats"], values: { "preserve-state": true }, raw: [] }),
    /bare-whole-stack only/,
  );
  await assert.rejects(
    () => down({ positionals: [], values: { "store-dir": root }, raw: [] }),
    /only valid with down --preserve-state/,
  );
  assert.deepEqual(backupComplete(["--only", ""]).items.map((item) => item.value), ["full", "registry"]);
  assert.deepEqual(upComplete(["--restore-only", ""]).items.map((item) => item.value), ["registry"]);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-1",
    state: "awaitingFinalize",
    durableCommitToken: "a".repeat(64),
  }, "restore-1"), true);
  assert.equal(isManagerCommitResult(undefined, "restore-1"), false);
  assert.equal(isManagerCommitResult({}, "restore-1"), false);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-2",
    state: "awaitingFinalize",
    durableCommitToken: "a".repeat(64),
  }, "restore-1"), false);
  assert.equal(isManagerCommitResult({ attemptId: "restore-1", state: "awaitingCommit" }, "restore-1"), false);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-1",
    state: "active",
    durableCommitToken: "a".repeat(64),
  }, "restore-1"), false);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-1",
    state: "awaitingFinalize",
    durableCommitToken: "short",
  }, "restore-1"), false);
  assert.equal(isManagerFinalizeResult({ attemptId: "restore-1", state: "active" }, "restore-1"), true);
  assert.equal(isManagerFinalizeResult({ attemptId: "restore-1", state: "awaitingFinalize" }, "restore-1"), false);

  const trustRoot = join(root, "trust-root");
  mkdirSync(trustRoot);
  const originalAuth = await createSpaceAuth("root_chain_drift");
  saveSpaceAuth(authDir(trustRoot), originalAuth);
  const originalFingerprint = await authorityFingerprint(trustRoot, originalAuth.space, "auth");
  const rotatedSystem = await rotateSystemAccount(originalAuth);
  assert.equal(rotatedSystem.account.pub, originalAuth.account.pub, "system rotation retains the data account");
  saveSpaceAuth(authDir(trustRoot), rotatedSystem);
  const rotatedFingerprint = await authorityFingerprint(trustRoot, originalAuth.space, "auth");
  assert.equal(rotatedFingerprint.account, originalFingerprint.account);
  assert.notEqual(
    rotatedFingerprint.authoritySha256,
    originalFingerprint.authoritySha256,
    "authority commitment changes when the validated operator/system root changes under the same data account",
  );

  const taskCheckpoint = consumerConfigFromCheckpoint("checkpoint_space", {
    stream: taskStream("checkpoint_space"),
    name: "svc_reviewer",
    ackFloorStreamSequence: 4,
    creationLowerBound: 1,
    streamState: { messages: 5, first_seq: 1, last_seq: 5 },
  });
  assert.equal(taskCheckpoint.deliver_policy, DeliverPolicy.All);
  assert.equal(taskCheckpoint.opt_start_seq, undefined, "TASK restore uses the core-owned WorkQueue policy");
  assert.throws(
    () => consumerConfigFromCheckpoint("checkpoint_space", {
      stream: dmStream("checkpoint_space"),
      name: "dm_owner-actor",
      ackFloorStreamSequence: 6,
      creationLowerBound: 1,
      streamState: { messages: 5, first_seq: 1, last_seq: 5 },
    }),
    /ACK floor exceeds snapshot last sequence/,
    "checkpoint cursors cannot escape their bound snapshot state",
  );

  const listener = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    listener.once("error", rejectListen);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const endpoint = `nats://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  await assert.rejects(
    assertEndpointUnreachable(endpoint),
    /to have no listener/,
    "a live listener is authoritative even without a pidfile or NATS handshake",
  );
  await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()));
  await assertEndpointUnreachable(endpoint);

  console.log("backup CLI smoke: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
