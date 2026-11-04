/** Owned local broker + synthetic old rows. No admission, host handler or production writer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAccount } from "@nats-io/nkeys";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { canonicalJson, contractDigest, createEndpointStreams, mintLifecycleUid, SERVICE_AUTHORITY_MAX_BYTES } from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { openLifecycleRegistry, registryStores } from "../src/lifecycle-registry.js";
import { appendNativeServiceCallerGrant, beginNativeServiceCallerRevocation, parseNativeServiceCallerPolicy } from "../src/service-caller-policy.js";
import type { ServiceCallerGrant } from "../src/service-host-contract.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
const dir = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? process.env.HOME!, SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), `listen: 127.0.0.1:${port}\nmax_payload: 4194304\njetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }\n`);
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
const bytes = (v: unknown) => Buffer.byteLength(canonicalJson(v)), enc = (v: unknown) => new TextEncoder().encode(canonicalJson(v));
try {
  for (let i = 0; i < 50; i++) {
    if (broker.exitCode !== null) throw new Error("owned fixture broker exited before readiness");
    try { nc = await connect({ servers, reconnect: false }); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  if (!nc) throw new Error("owned fixture broker did not bind");
  const space = "r9policycap", accountPublicKey = createAccount().getPublicKey(), owner = `u_${"a".repeat(26)}`;
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const reg = await openLifecycleRegistry(nc, space), kv = registryStores(reg).authKv;
  const binding = { accountPublicKey, space, grantee: { owner, actor: "caller", lifecycleUid: mintLifecycleUid() } };
  const digest = contractDigest({ approval: true });
  const grant: ServiceCallerGrant = { grantId: "a".repeat(32), endpoint: "example.service", instanceId: mintLifecycleUid(),
    serviceApprovalDigest: digest, capabilities: [], source: { kind: "service-owner", owner, approvalDigest: digest, nameAuthorityRevision: 1 },
    parentRefs: [], status: { state: "active" } };
  const row = { v: 1, ...binding, grants: [] as ServiceCallerGrant[] };
  const emptyBytes = bytes(row), unit = bytes(grant) + 1;
  const count = Math.floor((SERVICE_AUTHORITY_MAX_BYTES - emptyBytes + 1) / unit);
  for (let i = 0; i < count; i++) row.grants.push({ ...grant, grantId: i.toString(16).padStart(32, "0") });
  let remaining = SERVICE_AUTHORITY_MAX_BYTES - 1 - bytes(row);
  for (const g of row.grants) {
    const growth = Math.min(remaining, 64 - g.endpoint.length); g.endpoint += "x".repeat(growth); remaining -= growth;
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  const full = parseNativeServiceCallerPolicy(row), finalGrant = full.grants.pop()!;
  const key = `servicepolicy.${binding.grantee.lifecycleUid}`, rev = await kv.put(key, enc(full));
  let rejected = false;
  try { await appendNativeServiceCallerGrant(reg, binding, { expectedRevision: rev, grant: finalGrant }); }
  catch (e) { rejected = (e as { code?: string }).code === "resource-exhausted"; console.log("APPEND_REFUSAL", (e as Error).message); }
  const after = (await kv.get(key))!;
  console.log(JSON.stringify({ check: "new append reserves all-grant status growth", rejected, unchangedRevision: after.revision === rev,
    oldBytes: bytes(full), wouldBeBytes: bytes({ ...full, grants: [...full.grants, finalGrant] }), grantCount: count }));
  assert.equal(rejected, true, "append must reserve worst-case revocation headroom, not fill active bytes to2MiB");
  assert.equal(after.revision, rev, "refused append does not change the stored preimage");
  const operationId = "b".repeat(32);
  const maxStatus = { state: "revoking" as const, operationId, markerKey: "m".repeat(512),
    markerRevision: Number.MAX_SAFE_INTEGER, notBefore: Number.MAX_SAFE_INTEGER };
  const maxBytes = Math.max(bytes(maxStatus), bytes({ state: "revoking", operationId, phase: "cutoff-required" }),
    bytes({ state: "revoked", operationId, verifiedAt: Number.MAX_SAFE_INTEGER }));
  const reserve = maxBytes - bytes({ state: "active" });
  const safeBinding = { ...binding, grantee: { ...binding.grantee, lifecycleUid: mintLifecycleUid() } };
  const safe = { v: 1, ...safeBinding, grants: [] as ServiceCallerGrant[] };
  const safeCount = Math.floor((SERVICE_AUTHORITY_MAX_BYTES - bytes(safe) + 1) / (unit + reserve));
  for (let i = 0; i < safeCount - 1; i++) safe.grants.push({ ...grant, grantId: i.toString(16).padStart(32, "0") });
  const safeKey = `servicepolicy.${safeBinding.grantee.lifecycleUid}`, safeRev = await kv.put(safeKey, enc(safe));
  const accepted = await appendNativeServiceCallerGrant(reg, safeBinding, { expectedRevision: safeRev,
    grant: { ...grant, grantId: (safeCount - 1).toString(16).padStart(32, "0") } });
  const worst = { ...accepted.row, grants: accepted.row.grants.map(g => ({ ...g, status: maxStatus })) };
  assert.equal(parseNativeServiceCallerPolicy(worst).grants.length, safeCount);
  assert.ok(bytes(worst) <= SERVICE_AUTHORITY_MAX_BYTES);
  await assert.rejects(appendNativeServiceCallerGrant(reg, safeBinding, { expectedRevision: accepted.revision,
    grant: { ...grant, grantId: safeCount.toString(16).padStart(32, "0") } }), e => (e as { code?: string }).code === "resource-exhausted");
  const begun = await beginNativeServiceCallerRevocation(reg, safeBinding, { expectedRevision: accepted.revision,
    grantId: accepted.row.grants[0]!.grantId, operationId });
  assert.equal(begun.row.grants[0]!.status.state, "revoking");
  // Explicit compatibility hold: no retroactive repair, cap raise or pruning of already-full old rows.
  const oldBinding = { ...binding, grantee: { ...binding.grantee, lifecycleUid: mintLifecycleUid() } };
  const oldFull = { ...full, ...oldBinding, grants: [...full.grants, finalGrant] };
  const oldKey = `servicepolicy.${oldBinding.grantee.lifecycleUid}`, oldRev = await kv.put(oldKey, enc(oldFull));
  await assert.rejects(beginNativeServiceCallerRevocation(reg, oldBinding, { expectedRevision: oldRev,
    grantId: oldFull.grants[0]!.grantId, operationId }), e => (e as { code?: string }).code === "resource-exhausted");
  assert.equal((await kv.get(oldKey))!.revision, oldRev);
  console.log(JSON.stringify({ safeCount, worstStatusBytes: maxBytes, worstRowBytes: bytes(worst),
    oldRowsHeldUnrepaired: true, noProductionAdmission: true }));
} finally {
  await nc?.close();
  if (broker.exitCode === null && broker.signalCode === null) { const exited = once(broker, "exit"); broker.kill("SIGTERM"); await exited; }
  console.log(JSON.stringify({ ownedBrokerExit: broker.exitCode, signal: broker.signalCode, retainedScratch: dir }));
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
