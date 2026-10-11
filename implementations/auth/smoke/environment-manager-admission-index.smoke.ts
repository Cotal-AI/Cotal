import assert from "node:assert/strict";
import { DiscardPolicy, jetstream, jetstreamManager, RetentionPolicy, StorageType } from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { AUTHORITY_STORE_IMMUTABLE_FLAGS, credsClaims, credsFromJwt, ensureAuthorityStores, environmentBootstrapActor, mintLifecycleUid, newIdentity, WRITE_ONCE_PER_KEY } from "@cotal-ai/core";
import { stageEnvironmentManagerAdmission } from "../src/environment-manager-admission.js";
import { mintEnvironmentManagerBootstrap } from "../src/environment-manager-bootstrap-mint.js";
import { openLifecycleRegistry, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { environmentManagerAdmissionIndexGrants, environmentManagerAdmissionWriterGrants, openAuthorityClient } from "../src/authority-client.js";
import { environmentManagerAdmissionIndex, environmentManagerAdmissionIndexBucket, type EnvironmentManagerAdmissionSource } from "../src/environment-manager-admission-index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const fx = await startHostedAuthFixture("environment-index", 1);
const account = fx.accounts[0]!;
const writer = await openAuthorityClient({ server: fx.servers, space: account.space,
  dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
  label: "environment-manager-private-index", grants: id => environmentManagerAdmissionIndexGrants(account.space, id), log: () => {} });
let passed = 0, failed = 0;
const cell = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
};
try {
  const bucket = environmentManagerAdmissionIndexBucket(account.space);
  // Fixture provisioning uses the same closed host-private grant, not a widened test writer.
  await (await jetstreamManager(writer.nc)).streams.add({ name: `KV_${bucket}`, subjects: [`$KV.${bucket}.>`],
    storage: StorageType.File, retention: RetentionPolicy.Limits,
    max_age: 0, allow_direct: false, ...AUTHORITY_STORE_IMMUTABLE_FLAGS, ...WRITE_ONCE_PER_KEY });
  const kv = await new Kvm(writer.nc).open(bucket);
  const context = { space: account.space, accountPublicKey: account.accountPublicKey,
    authorityEndpoint: "ai.cotal.environment-authority", authorityInstanceId: mintLifecycleUid() };
  const index = await environmentManagerAdmissionIndex(kv, context);
  const source: EnvironmentManagerAdmissionSource = { environmentId: "a".repeat(64),
    caller: { owner: `u_${"a".repeat(26)}`, actor: "cli", uid: mintLifecycleUid() },
    profileDigest: `sha256:${"a".repeat(64)}`, environment: { kind: "tenki", id: "confirmed-native-provider-id" },
    expiresAt: Date.now() + 300_000 };
  let first: Awaited<ReturnType<typeof index.reserve>> | undefined;
  await cell("private index selects one manager instance lifecycle and operation", async () => {
    first = await index.reserve(source);
    assert.equal(first.owner, source.caller.owner);
    assert.equal(first.environmentId, source.environmentId);
    assert.ok(first.admissionRevision > 0);
    assert.equal(first.expiresAt, Math.floor(source.expiresAt / 1000));
    assert.equal(first.authorityInstanceId, context.authorityInstanceId);
    assert.equal(first.accountPublicKey, context.accountPublicKey);
    assert.notEqual(first.lifecycleUid, source.caller.uid);
    assert.deepEqual(await index.get(source.environmentId), first);
  });
  await cell("same-source replay and reconstruction retain the exact coordinates and revision", async () => {
    assert.deepEqual(await index.reserve(structuredClone(source)), first);
    const reconstructed = await environmentManagerAdmissionIndex(kv, context);
    assert.deepEqual(await reconstructed.reserve(source), first);
  });
  await cell("index-selected coordinates reach the native reservation under the same lifecycle", async () => {
    const authority = await openAuthorityClient({ server: fx.servers, space: account.space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
      label: "environment-index-native-reservation", grants: id => environmentManagerAdmissionWriterGrants(account.space, id), log: () => {} });
    try {
      await ensureAuthorityStores(await jetstreamManager(authority.nc), new Kvm(authority.nc), account.space);
      const reg = await openLifecycleRegistry(authority.nc, account.space);
      const coordinates = await index.reserve(source);
      await stageEnvironmentManagerAdmission(reg, coordinates);
      const head = await readLifecycleHeadForOperation(reg, coordinates.owner, environmentBootstrapActor(coordinates.instanceId));
      assert.equal(head?.mapping.lifecycleUid, coordinates.lifecycleUid);
      const peer = newIdentity();
      const material = await mintEnvironmentManagerBootstrap(reg, coordinates, { publicId: peer.id,
        credentialId: mintLifecycleUid(), expiresAt: Math.floor(Date.now() / 1000) + 120,
        account: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! } });
      assert.equal(credsClaims(credsFromJwt(material.jwt, peer)).nats?.issuer_account, context.accountPublicKey);
      assert.deepEqual(await index.reserve(source), coordinates);
    } finally { await authority.close(); }
  });
  await cell("concurrent first-wins reservations return one native coordinate set", async () => {
    const concurrent = { ...source, environmentId: "b".repeat(64) };
    const results = await Promise.all(Array.from({ length: 4 }, () => index.reserve(concurrent)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.notEqual(results[0]!.lifecycleUid, first?.lifecycleUid);
  });
  for (const [name, change] of [
    ["provider", { environment: { kind: "tenki", id: "foreign-provider-id" } }],
    ["profile", { profileDigest: `sha256:${"b".repeat(64)}` }],
    ["owner", { caller: { ...source.caller, owner: `u_${"b".repeat(26)}` } }],
    ["creator lifecycle", { caller: { ...source.caller, uid: mintLifecycleUid() } }],
    ["expiry", { expiresAt: source.expiresAt + 1000 }],
  ] as const) await cell(`changed ${name} cannot rebind an environment`, async () => {
    await assert.rejects(() => index.reserve({ ...source, ...change }), /another immutable/);
    assert.deepEqual(await index.get(source.environmentId), first);
  });
  await cell("an expired source refuses without an index reservation", async () => {
    const expired = { ...source, environmentId: "c".repeat(64), expiresAt: Date.now() - 1000 };
    await assert.rejects(() => index.reserve(expired), /expired/);
    assert.equal(await index.get(expired.environmentId), undefined);
  });
  await cell("a malformed or unconfirmed provider source refuses without a reservation", async () => {
    const missing = { ...source, environmentId: "d".repeat(64), environment: { kind: "tenki", id: "" } };
    await assert.rejects(() => index.reserve(missing), /malformed/);
    assert.equal(await index.get(missing.environmentId), undefined);
  });
  await cell("caller-selected manager coordinates are not admitted as source fields", async () => {
    await assert.rejects(() => index.reserve({ ...source, instanceId: mintLifecycleUid() } as EnvironmentManagerAdmissionSource), /malformed/);
    assert.deepEqual(await index.get(source.environmentId), first);
  });
  await cell("a foreign authority context cannot read the existing binding", async () => {
    const foreign = await environmentManagerAdmissionIndex(kv, { ...context, authorityInstanceId: mintLifecycleUid() });
    await assert.rejects(() => foreign.get(source.environmentId), /foreign context/);
  });
  await cell("a deletion marker cannot allocate another manager for the same environment", async () => {
    const erased = { ...source, environmentId: "e".repeat(64) };
    await kv.delete(`manager.${erased.environmentId}`);
    await assert.rejects(() => index.reserve(erased), /deletion is corruption/);
    assert.equal((await kv.get(`manager.${erased.environmentId}`))?.operation, "DEL");
  });
  await cell("a tombstone racing the initial read cannot resurrect an admission binding", async () => {
    const racing = { ...source, environmentId: "f".repeat(64) };
    const racingKey = `manager.${racing.environmentId}`;
    let injected = false;
    const seamedKv = new Proxy(kv, { get(target, field) {
      if (field === "get") return async (key: string) => {
        const before = await target.get(key);
        if (key === racingKey && !before && !injected) {
          injected = true;
          await target.delete(key);
        }
        return before;
      };
      const value = Reflect.get(target, field, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const seamed = await environmentManagerAdmissionIndex(seamedKv, context);
    await assert.rejects(() => seamed.reserve(racing), /deletion is corruption/);
    assert.equal((await kv.get(racingKey))?.operation, "DEL");
  });
  await cell("malformed stored identities refuse rather than being coerced to tokens", async () => {
    const entry = (await kv.get(`manager.${source.environmentId}`))!;
    const id = "2".repeat(64);
    const row = entry.json<{ source: EnvironmentManagerAdmissionSource }>();
    const damaged = { ...row, source: { ...row.source, environmentId: id }, lifecycleUid: 123 };
    await kv.put(`manager.${id}`, JSON.stringify(damaged));
    await assert.rejects(() => index.get(id), /identity is malformed/);
  });
  await cell("a deletion marker with plausible row bytes cannot become a binding", async () => {
    const id = "3".repeat(64), entry = (await kv.get(`manager.${source.environmentId}`))!;
    const row = entry.json<{ source: EnvironmentManagerAdmissionSource }>();
    const marked = { ...row, source: { ...row.source, environmentId: id } };
    const h = headers();
    h.set("KV-Operation", "DEL");
    await jetstream(writer.nc).publish(`$KV.${bucket}.manager.${id}`, JSON.stringify(marked), { headers: h });
    assert.equal((await kv.get(`manager.${id}`))?.operation, "DEL");
    await assert.rejects(() => index.reserve(marked.source), /deletion is corruption/);
  });
  await cell("native custody cannot delete a stored manager binding", async () => {
    await assert.rejects(() => kv.delete(`manager.${source.environmentId}`), error => error instanceof Error && "code" in error && error.code === 10077);
    assert.deepEqual(await index.reserve(source), first);
  });
  await cell("native stream protection refuses operator message erasure without reminting", async () => {
    const name = `KV_${bucket}`;
    // A separate exact-bucket fixture operator exercises stream protection, not custody ACL denial.
    const operator = await openAuthorityClient({ server: fx.servers, space: account.space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
      label: "environment-index-erase-operator", grants: id => ({
        publish: ["$JS.API.INFO", `$JS.API.STREAM.MSG.DELETE.${name}`, `$JS.API.STREAM.PURGE.${name}`],
        subscribe: [`_INBOX_${id}.>`],
      }), log: () => {} });
    try {
      const admin = await jetstreamManager(operator.nc);
      const seq = (await kv.get(`manager.${source.environmentId}`))!.revision;
      await assert.rejects(() => admin.streams.deleteMessage(name, seq), error => error instanceof Error && "code" in error && error.code === 10057);
      await assert.rejects(() => admin.streams.purge(name, { filter: `$KV.${bucket}.manager.${source.environmentId}` }), error => error instanceof Error && "code" in error && error.code === 10110);
      assert.deepEqual(await index.reserve(source), first);
    } finally { await operator.close(); }
  });
  await cell("a different bucket context is not accepted as this private index", async () => {
    await assert.rejects(() => environmentManagerAdmissionIndex(kv, { ...context, space: `${account.space}-other` }), /needs private/);
  });
  await cell("native memory and follower-readable stores refuse at the index boundary", async () => {
    for (const [suffix, storage, direct] of [["memory", StorageType.Memory, false], ["direct", StorageType.File, true]] as const) {
      const space = `${account.space}-${suffix}`, bucket = environmentManagerAdmissionIndexBucket(space);
      const custody = await openAuthorityClient({ server: fx.servers, space,
        dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
        label: `environment-index-shape-${suffix}`, grants: id => environmentManagerAdmissionIndexGrants(space, id), log: () => {} });
      try {
        await (await jetstreamManager(custody.nc)).streams.add({ name: `KV_${bucket}`, subjects: [`$KV.${bucket}.>`],
          storage, retention: RetentionPolicy.Limits,
          max_age: 0, allow_direct: direct, ...AUTHORITY_STORE_IMMUTABLE_FLAGS, ...WRITE_ONCE_PER_KEY });
        const malformed = await new Kvm(custody.nc).open(bucket);
        await assert.rejects(() => environmentManagerAdmissionIndex(malformed, { ...context, space }), /needs private/);
      } finally { await custody.close(); }
    }
  });
  await cell("native custody cannot replace an immutable manager binding", async () => {
    const immutable = { ...source, environmentId: "1".repeat(64) };
    const coordinates = await index.reserve(immutable);
    const entry = (await kv.get(`manager.${immutable.environmentId}`))!;
    const replacement = { ...entry.json<Record<string, unknown>>(), instanceId: mintLifecycleUid() };
    await assert.rejects(() => kv.put(entry.key, JSON.stringify(replacement)));
    assert.deepEqual(await index.reserve(immutable), coordinates);
  });
  for (const flag of ["discard_new_per_subject", "deny_delete", "deny_purge"] as const)
    await cell(`native index store missing ${flag} refuses at admission`, async () => {
      const space = `${account.space}-${flag}`, bucket = environmentManagerAdmissionIndexBucket(space);
      const custody = await openAuthorityClient({ server: fx.servers, space,
        dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
        label: `environment-index-shape-${flag}`, grants: id => environmentManagerAdmissionIndexGrants(space, id), log: () => {} });
      try {
        await (await jetstreamManager(custody.nc)).streams.add({ name: `KV_${bucket}`, subjects: [`$KV.${bucket}.>`],
          storage: StorageType.File, retention: RetentionPolicy.Limits, discard: DiscardPolicy.New,
          max_msgs_per_subject: 1, max_age: 0, allow_direct: false, allow_rollup_hdrs: false,
          discard_new_per_subject: true, deny_delete: true, deny_purge: true, [flag]: false });
        const mutable = await new Kvm(custody.nc).open(bucket);
        await assert.rejects(() => environmentManagerAdmissionIndex(mutable, { ...context, space }), /needs private/);
      } finally { await custody.close(); }
    });
  await cell("native index store republishing private coordinates refuses at admission", async () => {
    const space = `${account.space}-republish`, bucket = environmentManagerAdmissionIndexBucket(space);
    const custody = await openAuthorityClient({ server: fx.servers, space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! },
      label: "environment-index-shape-republish", grants: id => environmentManagerAdmissionIndexGrants(space, id), log: () => {} });
    try {
      await (await jetstreamManager(custody.nc)).streams.add({ name: `KV_${bucket}`, subjects: [`$KV.${bucket}.>`],
        storage: StorageType.File, retention: RetentionPolicy.Limits, discard: DiscardPolicy.New,
        max_msgs_per_subject: 1, max_age: 0, allow_direct: false, allow_rollup_hdrs: false,
        discard_new_per_subject: true, deny_delete: true, deny_purge: true,
        republish: { src: `$KV.${bucket}.>`, dest: "review.metadata.>" } });
      const republishing = await new Kvm(custody.nc).open(bucket);
      await assert.rejects(() => environmentManagerAdmissionIndex(republishing, { ...context, space }), /needs private/);
    } finally { await custody.close(); }
  });
  await cell("private index grants carry no auth-store direct-read or lifecycle authority", async () => {
    const grants = environmentManagerAdmissionIndexGrants(account.space, "private-index-control");
    assert.equal(grants.publish.length, 5);
    assert.ok(grants.publish.every(row => row === "$JS.API.INFO" || row.includes(bucket)));
    assert.ok(!grants.publish.some(row => row.includes("DIRECT.GET") || row.includes("cotal_auth_") || row.includes("cotal_records_")));
    assert.deepEqual(grants.subscribe, ["_INBOX_private-index-control.>"]);
  });
} finally {
  await writer.close();
  await fx.close();
  emitSentinel({ passed, failed });
  process.exitCode = failed === 0 ? 0 : 1;
}
