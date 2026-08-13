/**
 * #286 (AUTH mode) — presence/lease TTL migration GRANT proof. `kvm.create(bucket, {ttl})` NEVER updates an
 * existing bucket, so a presence/lease bucket created by a cotal that predated the TTL keeps NO `max_age` and
 * never expires dead presence records / stale leases — a raw-KV reader (a dashboard) then shows a crashed agent
 * as live forever. `setupSpaceStreams` reconciles the three TTL'd buckets' `max_age` (STREAM.UPDATE), which
 * requires the `provisioner` cred to hold STREAM.UPDATE on exactly those three streams (provision.ts).
 *
 * Runs against a REAL auth-callout broker AS the REAL provisioner credential, so it proves THE GRANT — the one
 * thing unique to auth mode. A fresh `cotal up` never exercises it (a just-created bucket already has the TTL, so
 * the reconcile skips the update), so we stage the old-deployment shape: pre-create the three buckets WITHOUT
 * max_age (as the provisioner's STREAM.CREATE), then run setupSpaceStreams as the provisioner and assert all
 * three `max_age` values flip from 0 to their TTLs. Without the STREAM.UPDATE grant, setupSpaceStreams throws a
 * permissions violation at the reconcile — so reaching the post-asserts IS the proof.
 *
 * The behavioral consequence (a stale record then ages out; an active lease, always younger than its TTL,
 * survives) is plain NATS `max_age` semantics, proven live in open mode by `_r286-mig.ts` / `_r286.ts` — not
 * re-proven here, where writing presence/lease records would need agent/delivery creds (the provisioner writes
 * neither). Needs `nats-server` on PATH. Run: pnpm smoke:presence-ttl-migration:auth
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, nanos } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, setupSpaceStreams, standaloneConnectOpts, presenceBucket, deliveryBucket, managerBucket } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `ttlmig-${randomUUID().slice(0, 8)}`;
const PRESENCE_MS = 6_000, DELIVERY_MS = 30_000, MANAGER_MS = 10_000;

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-ttlmig-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  console.log(`  ✓ ${name}`);
  pass++;
};

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) break; await sleep(200); }

  // The REAL provisioner credential — the identity `setupSpaceStreams` runs as at `cotal up`.
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  // Pin the reply inbox to the provisioner's own `_INBOX_<id>` — its scoped cred rejects the default
  // `_INBOX.<nuid>`, so a bare connect would hang every JS-API request (same as `setupSpaceStreams`).
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: provCreds }) });
  const kvm = new Kvm(nc);
  const jsm = await jetstreamManager(nc);
  const maxAge = async (b: string) => (await jsm.streams.info(`KV_${b}`)).config.max_age;

  // OLD deployment: the three TTL'd buckets pre-created (by the provisioner's STREAM.CREATE) with NO max_age.
  await kvm.create(presenceBucket(space), {});
  await kvm.create(deliveryBucket(space), {});
  await kvm.create(managerBucket(space), {});
  check("pre-existing presence bucket has NO expiry (max_age=0)", (await maxAge(presenceBucket(space))) === 0);
  check("pre-existing delivery-lease bucket has NO expiry (max_age=0)", (await maxAge(deliveryBucket(space))) === 0);
  check("pre-existing manager-lease bucket has NO expiry (max_age=0)", (await maxAge(managerBucket(space))) === 0);

  // THE FIX, as the real provisioner: setupSpaceStreams reconciles max_age via STREAM.UPDATE. Without the
  // grant this throws a permissions violation here — so reaching the asserts proves the grant is correct.
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });

  check("presence max_age reconciled to 6s (provisioner STREAM.UPDATE authorized)", (await maxAge(presenceBucket(space))) === nanos(PRESENCE_MS), (await maxAge(presenceBucket(space))) / 1e6);
  check("delivery-lease max_age reconciled to 30s", (await maxAge(deliveryBucket(space))) === nanos(DELIVERY_MS), (await maxAge(deliveryBucket(space))) / 1e6);
  check("manager-lease max_age reconciled to 10s", (await maxAge(managerBucket(space))) === nanos(MANAGER_MS), (await maxAge(managerBucket(space))) / 1e6);

  // Idempotent: a second reconcile pass (a normal repeat `cotal up`) is a no-op — matching max_age, no UPDATE.
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  check("second reconcile is a no-op (max_age still 6s — idempotent)", (await maxAge(presenceBucket(space))) === nanos(PRESENCE_MS));

  await nc.close();
  console.log(`\nPRESENCE-TTL-MIGRATION (auth) SMOKE OK ✅  (${pass} checks)`);
} finally {
  srv.kill("SIGKILL");
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
