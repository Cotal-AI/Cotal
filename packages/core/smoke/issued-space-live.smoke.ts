import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  acceptedBucket, acceptedKey, ensureIssuedStores, importNativeSubjectPermissions,
  issuedBucket, issuedEvidenceKey, openIssuedStore, readAcceptedRow, writeAcceptedRow,
  type IssuedAuthorityRef, type IssuedEvidence,
} from "../src/issued-authority.js";
import {
  SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal, emitSentinel,
} from "@cotal-ai/smoke-kit";
import { isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}
const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  const servers = `nats://127.0.0.1:${port}`;
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers: `nats://127.0.0.1:${port}` });
  const connection = nc;
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  const space = "u_example-member";
  await ensureIssuedStores(jsm, kvm, space);
  const kv = await kvm.open(issuedBucket(space));
  const accepted = await kvm.open(acceptedBucket(space));
  const ref: IssuedAuthorityRef = { space, owner: "local", actor: "caller", uid: "a".repeat(26), generation: "b".repeat(32) };
  const source = { space, bucket: `cotal_auth_${space}`, key: `cred.${ref.uid}` };
  const permissions = importNativeSubjectPermissions({ pub: { allow: [`cotal.${space}.ep.v1.one.manager.status.local.caller.${ref.uid}.${ref.generation}.*`] }, sub: { deny: [">"] } });
  const evidence: IssuedEvidence = { version: 1, ref, sources: [source], permissions };
  await check("live underscore space stages releases resolves and binds its accepted row", async () => {
    const store = openIssuedStore(kv, jsm, space);
    const staged = await store.stage(evidence);
    assert.equal(staged.key, issuedEvidenceKey(ref));
    await assert.rejects(() => store.resolve(ref, async () => true), /prepared/);
    let finalized = false;
    await store.release(staged, async () => { finalized = true; });
    assert.equal(finalized, true);
    const resolved = await store.resolve(ref, async (actual) => {
      assert.deepEqual(actual, source);
      return true;
    });
    assert.deepEqual(resolved.evidence, evidence);
    const acceptedToken = "c".repeat(32);
    await writeAcceptedRow(accepted, acceptedToken, ref);
    assert.deepEqual(await readAcceptedRow(connection, space, acceptedToken), ref);
    await store.confirm(ref, permissions);
    await assert.rejects(() => store.confirm(ref, importNativeSubjectPermissions({})), /different ceiling/);
    await assert.rejects(() => store.resolve(ref, async () => false), /no longer live/);
    assert.equal(await store.retireSource(source), 1);
    await assert.rejects(() => store.resolve(ref, async () => true), /revoked/);
  });
  await check("live underscore store rejects foreign reference and source before writing", async () => {
    const store = openIssuedStore(kv, jsm, space);
    await assert.rejects(() => store.stage({ ...evidence, ref: { ...ref, space: "foreign_space" }, sources: [] , expiresAt: 2_000_000_000 }), /foreign space/);
    await assert.rejects(() => store.stage({ ...evidence, sources: [{ ...source, space: "foreign_space" }] }), /foreign space/);
  });
  await check("live accepted row still refuses a foreign space reference", async () => {
    const acceptedToken = "d".repeat(32);
    await writeAcceptedRow(accepted, acceptedToken, { ...ref, space: "foreign_space" });
    await assert.rejects(() => readAcceptedRow(connection, space, acceptedToken), /foreign space/);
  });
  await check("live accepted row refuses malformed space without broker aliasing", async () => {
    const acceptedToken = "e".repeat(32);
    await assert.rejects(() => writeAcceptedRow(accepted, acceptedToken, { ...ref, space: "u.example-member" }));
    assert.equal(await accepted.get(acceptedKey(acceptedToken)), null);
  });
} finally {
  if (nc) await nc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
console.log(`ISSUED SPACE LIVE SMOKE (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
