/** Run after building core: pnpm smoke:issued-observe:live (needs nats-server). The disclosure read
 *  against a throwaway broker: it answers for an active generation whose source is dead, which
 *  resolve refuses, and it refuses a prepared, retired or expired one as resolve does. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  ensureIssuedStores, importNativeSubjectPermissions, issuedBucket, mintGeneration, openIssuedStore,
  type IssuedAuthorityRef, type IssuedEvidence,
} from "../src/issued-authority.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
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
  nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  const space = "observe";
  await ensureIssuedStores(jsm, kvm, space);
  const store = openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space);
  const now = Math.floor(Date.now() / 1000);
  const evidenceFor = (actor: string, extra: Partial<IssuedEvidence> = {}): IssuedEvidence => {
    const ref: IssuedAuthorityRef = { space, owner: "local", actor, uid: "a".repeat(26), generation: mintGeneration(now + 3600) };
    const source = { space, bucket: `cotal_auth_${space}`, key: `cred.${ref.uid}` };
    const permissions = importNativeSubjectPermissions({ pub: { allow: [`cotal.${space}.ep.v1.one.registry.endpoints.local.${actor}.${ref.uid}.${ref.generation}.*`] }, sub: { deny: [">"] } });
    return { version: 1, ref, sources: [source], permissions, ...extra };
  };

  await check("observe answers an active generation whose source is dead, which resolve refuses", async () => {
    const evidence = evidenceFor("dead_source");
    await store.release(await store.stage(evidence), async () => {});
    await assert.rejects(() => store.resolve(evidence.ref, async () => false), /no longer live/);
    const observed = await store.observe(evidence.ref);
    assert.deepEqual(observed.evidence, evidence);
  });

  await check("observe refuses a prepared generation", async () => {
    const evidence = evidenceFor("prepared");
    await store.stage(evidence);
    await assert.rejects(() => store.observe(evidence.ref), /is prepared/);
  });

  await check("observe refuses a retired generation", async () => {
    const evidence = evidenceFor("retired");
    await store.release(await store.stage(evidence), async () => {});
    await store.retire(evidence.ref);
    await assert.rejects(() => store.observe(evidence.ref), /is revoked/);
  });

  await check("observe refuses expired evidence and a generation past its horizon", async () => {
    const evidence = evidenceFor("expiring", { sources: [], expiresAt: now + 5 });
    await store.release(await store.stage(evidence), async () => {});
    await assert.rejects(() => store.observe(evidence.ref, () => now + 10), /expired at/);
    await assert.rejects(() => store.observe(evidence.ref, () => now + 7200), /expired at/);
  });

  await check("observe refuses a generation with no evidence", async () => {
    await assert.rejects(() => store.observe(evidenceFor("absent").ref));
  });
} finally {
  if (nc) await nc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
