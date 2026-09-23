/**
 * #404: TTL reconciliation succeeds only on evidence that the backing store enforces `max_age`.
 *
 * The forced file-store fault is the reported mechanism, not a mock: after one message is stored, only
 * the stream metadata directory becomes 0500. nats-server accepts STREAM.UPDATE and INFO reports the new
 * config, but the file store rolls back before starting expiry. Reconcile must throw
 * `TtlPersistenceError`, including on its second matching-INFO pass.
 *
 * Healthy file and memory streams are controls. Both must reconcile successfully and their canaries must
 * disappear. The file control proves the detector is not merely rejecting file storage; the memory
 * control preserves the non-persistent stream behavior.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, StorageType } from "@nats-io/jetstream";
import { isReachable, reconcileBucketTtl, TtlPersistenceError } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "./_ephemeral-only.js";

scrubAmbientBrokerEnv();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ttlMs = 1_000;
const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
assertEphemeralBroker(servers);
const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(root, "server.conf"), `port: ${port}\njetstream { store_dir: "${join(root, "js")}" }\n`);
const broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
let pass = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  assert.ok(condition, `${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  console.log(`  ✓ ${name}`);
  pass++;
};
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(100); }
  const nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);

  async function add(bucket: string, storage: StorageType): Promise<string> {
    const stream = `KV_${bucket}`;
    await jsm.streams.add({ name: stream, subjects: [`$KV.${bucket}.>`], storage, max_age: 0 });
    await js.publish(`$KV.${bucket}.existing`, new TextEncoder().encode("existing"));
    return stream;
  }

  const brokenBucket = `ttl404_broken_${randomUUID().slice(0, 8)}`;
  const brokenStream = await add(brokenBucket, StorageType.File);
  const meta = walk(join(root, "js")).find((path) => path.endsWith(`/${brokenStream}/meta.inf`));
  assert.ok(meta, "file stream metadata exists");
  const streamDir = meta.slice(0, -"/meta.inf".length);
  chmodSync(streamDir, 0o500);
  try {
    let first: Error | undefined;
    try { await reconcileBucketTtl(jsm, js, brokenStream, brokenBucket, ttlMs); }
    catch (error) { first = error as Error; }
    check("forced file-store metadata failure is a named TtlPersistenceError", first instanceof TtlPersistenceError, first?.message);
    check("the named error says the server accepted config but the store did not persist it", /server accepted/.test(first?.message ?? "") && /store did not persist/.test(first?.message ?? ""), first?.message);
    check("INFO still false-greens at the requested max_age", (await jsm.streams.info(brokenStream)).config.max_age === ttlMs * 1e6);

    let second: Error | undefined;
    try { await reconcileBucketTtl(jsm, js, brokenStream, brokenBucket, ttlMs); }
    catch (error) { second = error as Error; }
    check("a second matching-INFO reconcile still fails instead of skipping", second instanceof TtlPersistenceError, second?.message);
    check("the failed store retains the record and canary past the TTL", (await jsm.streams.info(brokenStream)).state.messages >= 2);
  } finally {
    chmodSync(streamDir, 0o700);
  }

  for (const [label, storage] of [["file", StorageType.File], ["memory", StorageType.Memory]] as const) {
    const bucket = `ttl404_${label}_${randomUUID().slice(0, 8)}`;
    const stream = await add(bucket, storage);
    const changed = await reconcileBucketTtl(jsm, js, stream, bucket, ttlMs);
    check(`healthy ${label} store reconcile succeeds`, changed?.toMs === ttlMs, changed);
    check(`healthy ${label} store enforces max_age and expires its canary`, (await jsm.streams.info(stream)).state.messages === 0);
    const repeat = await reconcileBucketTtl(jsm, js, stream, bucket, ttlMs);
    check(`healthy ${label} store matching-INFO pass sees no pending canary and stays read-only`, repeat === undefined, repeat);
  }

  await nc.close();
  console.log(`\nPRESENCE-TTL-PERSISTENCE SMOKE OK ✅  (${pass} checks)`);
} finally {
  broker.kill("SIGKILL");
  await sleep(200);
  rmSync(root, { recursive: true, force: true });
  releaseBroker();
}
