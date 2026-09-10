import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { createEndpointStreams, epAuthBucket, recordsBucket, lifecycleHeadKey, credRowKey, isCasLoss, isReachable } from "@cotal-ai/core";
import { SignJWT, generateKeyPair } from "jose";
import { prepareCredentialReleaseFence } from "./prototypes/credential-release-fence.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { authorizeConnectCredential, openConnectReader } from "../src/connect-reader.js";
import { deriveOwnerToken } from "../src/derive.js";
import { USER_TOKEN_VER, validateUserToken, type ValidatedUserToken } from "../src/token.js";
import { markLedgerRowRevoked } from "../src/credential-ledger.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { activateLifecycle, openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { stageAgentMint, finalizeAgentMint, createSourceGateOpen, observeSourceGate, freezeSourceGate } from "../src/credential-ledger.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { evidenceKey, openIssuedLifecycle, sourceIndexKey, sourcePrefix, type IssuedRef, type SourceRef } from "../../../packages/core/smoke/prototypes/issued-authority-lifecycle.js";
import { requestedSubjectPermission } from "../../../packages/core/smoke/prototypes/issued-subject-permissions.js";

let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); } catch (error) { console.error(`  FAIL: ${name}`); throw error; }
  console.log(`  ok ${name}`);
  passed++;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const space = "issuedproof";
const REVOKER_ROWS = (space: string) => {
  const bucket = `cotal_issued_${space}`, stream = `KV_${bucket}`;
  return [
    `$KV.${bucket}.>`, "$JS.API.INFO", `$JS.API.STREAM.INFO.${stream}`,
    `$JS.API.STREAM.MSG.GET.${stream}`, `$JS.API.CONSUMER.CREATE.${stream}`,
    `$JS.API.CONSUMER.CREATE.${stream}.>`, `$JS.API.CONSUMER.MSG.NEXT.${stream}.>`,
    `$JS.API.CONSUMER.DELETE.${stream}.>`, `$JS.API.CONSUMER.INFO.${stream}.>`, `$JS.ACK.${stream}.>`,
  ];
};

const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const revokerPerms = { publish: { allow: REVOKER_ROWS(space) }, subscribe: { allow: ["_INBOX_issuedrevoker.>"] } };
writeFileSync(join(dir, "server.conf"), `listen: 127.0.0.1:${port}\njetstream { store_dir: ${JSON.stringify(dir)} }\nauthorization { users: [{user: "issuer", password: "synthetic-proof"}, {user: "revoker", password: "synthetic-revoker", permissions: ${JSON.stringify(revokerPerms)}}] }\n`);
const spawnBroker = () => {
  const child = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  return { child, exited: new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); }) };
};
let { child: broker, exited } = spawnBroker();
let releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  const server = `nats://issuer:synthetic-proof@127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(server); if (!up) await wait(50); }
  assert.ok(up, "isolated broker must start");
  nc = await connect({ servers: `nats://127.0.0.1:${port}`, user: "issuer", pass: "synthetic-proof", maxReconnectAttempts: 0 });
  const kvm = new Kvm(nc);
  await createEndpointStreams(await jetstreamManager(nc), kvm, space);
  const reg = await openLifecycleRegistry(nc, space, makeLedgerScannerOverConnection(nc, space));
  const authKv = await kvm.open(epAuthBucket(space));
  const recordsKv = await kvm.open(recordsBucket(space));
  const reader = await openConnectReader(nc, space);
  const kv = await kvm.create(`cotal_issued_${space}`, { storage: "file", allow_direct: false });
  const lifecycle = await openIssuedLifecycle(kv, space);
  const permissions = { publish: requestedSubjectPermission(["proof.public"]), subscribe: requestedSubjectPermission([]) };
  const read = async (store: KV, key: string) => {
    const e = await store.get(key);
    assert.ok(e && e.operation === "PUT", `expected durable PUT at ${key}`);
    return { value: JSON.parse(new TextDecoder().decode(e.value)), revision: e.revision };
  };
  const state = async (ref: IssuedRef) => (await read(kv, `attempt.${evidenceKey(ref)}`)).value.state;
  const live = async (source: SourceRef) => {
    assert.equal(source.space, space);
    assert.equal(source.bucket, epAuthBucket(space));
    return (await read(authKv, source.key)).value.state === "open";
  };
  let fixtureNumber = 0;
  async function fixture() {
    const actor = `proof${++fixtureNumber}`;
    const activated = await activateLifecycle(reg, { owner: "local", actor, managerInstance: "issuer-proof" });
    const uid = activated.mapping.lifecycleUid;
    const handle = { issuerKeyId: "proof", id: actor };
    await createSourceGateOpen(reg, handle);
    const mintArgs = { lifecycleUid: uid, credentialId: "sharedroot", holderPrincipal: `local.${actor}`, sourceChain: [`handle.proof.${actor}`], exp: Date.now() + 600_000 };
    return {
      async next(store = lifecycle) {
        const mint = await stageAgentMint(reg, mintArgs);
        const ref: IssuedRef = { space, owner: "local", actor, uid, generation: randomBytes(16).toString("hex") };
        const sources = mint.pins.map((pin) => ({ space, bucket: epAuthBucket(space), key: pin.key }));
        const material = `synthetic-result-${ref.generation}`;
        const prepared = await store.stage(ref, permissions, sources, material);
        return { ref, sources, prepared, material, mint, finalize: () => finalizeAgentMint(reg, mint) };
      },
      async freeze() {
        const observed = await observeSourceGate(reg, handle);
        assert.ok(observed);
        await freezeSourceGate(reg, { ...handle, revision: observed.revision });
        return { space, bucket: epAuthBucket(space), key: `srcgate.proof.${actor}` };
      },
    };
  }

  await check("release waits for the pending existing finalizer before activation", async () => {
    const f = await fixture();
    const a = await f.next();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let entered = false;
    let settled = false;
    const result = lifecycle.release(a.prepared, async () => {
      entered = true;
      await blocked;
      await a.finalize();
    });
    void result.then(() => { settled = true; }, () => { settled = true; });
    try {
      assert.equal(entered, true);
      // Activation and this read are both round trips, so a single sample races the writer and can
      // pass while the attempt is already active. Watch a bounded window: a release that does not
      // await its finalizer flips the state inside it.
      for (let i = 0; i < 15; i++) {
        assert.equal(await state(a.ref), "prepared", `activated at sample ${i} while the finalizer was blocked`);
        assert.equal(settled, false);
        await wait(20);
      }
    } finally {
      unblock();
      await result.catch(() => undefined);
    }
    assert.equal(await result, a.material);
  });

  await check("release runs the existing finalizer after durable evidence and indexes", async () => {
    const f = await fixture();
    const a = await f.next();
    const before = await read(authKv, a.mint.pins[0].key);
    let finalized = 0;
    const result = await lifecycle.release(a.prepared, async () => {
      assert.equal(await state(a.ref), "prepared");
      assert.deepEqual((await read(kv, evidenceKey(a.ref))).value.ref, a.ref);
      for (const source of a.sources) {
        assert.deepEqual((await read(kv, sourceIndexKey(source, a.ref))).value, { source, ref: a.ref });
      }
      await a.finalize();
      finalized++;
    });
    assert.equal(finalized, 1);
    assert.ok((await read(authKv, a.mint.pins[0].key)).revision > before.revision);
    assert.equal(result, a.material);
    assert.equal(await state(a.ref), "active");
    assert.deepEqual(await lifecycle.resolve(a.ref, live), permissions);
  });

  await check("two issuances of one root credential retain distinct generation indexes", async () => {
    const f = await fixture();
    const a = await f.next();
    await lifecycle.release(a.prepared, a.finalize);
    const b = await f.next();
    await lifecycle.release(b.prepared, b.finalize);
    assert.equal(a.mint.rowKey, b.mint.rowKey);
    for (const source of a.sources) {
      assert.notEqual(sourceIndexKey(source, a.ref), sourceIndexKey(source, b.ref));
      assert.deepEqual((await read(kv, sourceIndexKey(source, a.ref))).value.ref, a.ref);
      assert.deepEqual((await read(kv, sourceIndexKey(source, b.ref))).value.ref, b.ref);
    }
    assert.equal(await lifecycle.retireSource(await f.freeze()), 2);
    assert.equal(await state(a.ref), "revoked");
    assert.equal(await state(b.ref), "revoked");
  });

  await check("source freeze before finalization releases nothing and aborts the attempt", async () => {
    const f = await fixture();
    const a = await f.next();
    await f.freeze();
    await assert.rejects(lifecycle.release(a.prepared, a.finalize), /lost its fence/);
    assert.equal(await state(a.ref), "aborted");
    assert.equal((await read(authKv, a.mint.rowKey)).value.state, "revoked");
    await assert.rejects(lifecycle.resolve(a.ref, live), /not active/);
  });

  await check("a winning source fence followed by prepared retirement loses activation", async () => {
    const f = await fixture();
    const a = await f.next();
    let fenceWon = false;
    await assert.rejects(lifecycle.release(a.prepared, async () => {
      await a.finalize();
      fenceWon = true;
      assert.equal(await lifecycle.retireSource(await f.freeze()), 1);
      assert.equal(await state(a.ref), "aborted");
    }));
    assert.equal(fenceWon, true);
    assert.equal(await state(a.ref), "aborted");
    await assert.rejects(lifecycle.resolve(a.ref, live), /not active/);
  });

  await check("activation before the source walk is irreversibly revoked", async () => {
    const f = await fixture();
    const a = await f.next();
    await lifecycle.release(a.prepared, a.finalize);
    const source = await f.freeze();
    await assert.rejects(lifecycle.resolve(a.ref, live), /source is not live/);
    assert.equal(await lifecycle.retireSource(source), 1);
    assert.equal(await state(a.ref), "revoked");
    assert.equal(await lifecycle.retire(a.ref), "revoked");
    await assert.rejects(lifecycle.stage(a.ref, permissions, a.sources, a.material), /already exists/);
  });

  await check("resolution rechecks revocation after awaiting source authorization", async () => {
    const f = await fixture();
    const a = await f.next();
    await lifecycle.release(a.prepared, a.finalize);
    let retired = false;
    await assert.rejects(lifecycle.resolve(a.ref, async (source) => {
      if (!retired) { await lifecycle.retire(a.ref); retired = true; }
      return live(source);
    }), /changed during resolution/);
  });

  await check("restart can abort a prepared attempt but cannot release its material", async () => {
    const f = await fixture();
    const a = await f.next();
    const restarted = await openIssuedLifecycle(kv, space);
    await assert.rejects(restarted.resolve(a.ref, live), /not active/);
    await assert.rejects(restarted.release(a.prepared, a.finalize), /unknown or consumed/);
    assert.equal(await restarted.retire(a.ref), "aborted");
    await assert.rejects(lifecycle.release(a.prepared, a.finalize));
    assert.equal(await state(a.ref), "aborted");
  });

  await check("lost activation acknowledgement releases nothing and retires committed state", async () => {
    let lost = false;
    const uncertainKv = new Proxy(kv, {
      get(target, prop) {
        if (prop === "update") return async (key: string, data: Uint8Array, revision: number) => {
          const result = await target.update(key, data, revision);
          if (!lost && JSON.parse(new TextDecoder().decode(data)).state === "active") {
            lost = true;
            throw new Error("synthetic lost activation acknowledgement");
          }
          return result;
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const uncertain = await openIssuedLifecycle(uncertainKv, space);
    const f = await fixture();
    const a = await f.next(uncertain);
    await assert.rejects(uncertain.release(a.prepared, a.finalize), /lost activation acknowledgement/);
    assert.equal(lost, true);
    assert.equal(await state(a.ref), "revoked");
    await assert.rejects(lifecycle.resolve(a.ref, live), /not active/);
  });

  await check("unknown handles and reused release handles cannot invoke a finalizer", async () => {
    const f = await fixture();
    const a = await f.next();
    let calls = 0;
    const finalize = async () => { calls++; await a.finalize(); };
    await assert.rejects(lifecycle.release({ key: a.prepared.key }, finalize), /unknown or consumed/);
    assert.equal(calls, 0);
    await lifecycle.release(a.prepared, finalize);
    await assert.rejects(lifecycle.release(a.prepared, finalize), /unknown or consumed/);
    assert.equal(calls, 1);
  });

  await check("unavailable source authorization refuses an otherwise active generation", async () => {
    const f = await fixture();
    const a = await f.next();
    await lifecycle.release(a.prepared, a.finalize);
    await assert.rejects(lifecycle.resolve(a.ref, async () => { throw new Error("synthetic source outage"); }), /source outage/);
  });

  await check("the index walk runs on a least-privilege revoker credential, not an operator one", async () => {
    // The walk is what a production revoker performs, so it must not need space-wide reach. This
    // principal is granted the issued bucket and nothing else.
    const scopedNc = await connect({ servers: `nats://127.0.0.1:${port}`, user: "revoker", pass: "synthetic-revoker", inboxPrefix: "_INBOX_issuedrevoker", maxReconnectAttempts: 0 });
    try {
      const scoped = await openIssuedLifecycle(await new Kvm(scopedNc).open(`cotal_issued_${space}`), space);
      const f = await fixture();
      const a = await f.next();
      await lifecycle.release(a.prepared, a.finalize);
      assert.equal(await scoped.retireSource(await f.freeze()), 1);
      assert.equal(await state(a.ref), "revoked");
      // Same credential, another bucket in the same space: refused. The walk gained no extra reach.
      // Kvm.open is lazy, so the read is what reaches the broker.
      const foreign = await new Kvm(scopedNc).open(epAuthBucket(space));
      await assert.rejects(foreign.get(a.sources[0].key), /[Pp]ermission/);
    } finally { await scopedNc.close(); }
  });

  await check("an unreadable attempt row refuses instead of resolving", async () => {
    // Absence of a revocation is carried by the attempt row's state, so a failed READ of that row
    // is not the same as "no revocation". The resolver must refuse rather than treat it as active.
    let outage = false;
    const flaky = new Proxy(kv, {
      get(target, property, receiver) {
        if (property !== "get") return Reflect.get(target, property, receiver);
        return async (key: string) => {
          if (outage && key.startsWith("attempt.")) throw new Error("synthetic attempt-store outage");
          return target.get(key);
        };
      },
    }) as KV;
    const guarded = await openIssuedLifecycle(flaky, space);
    const f = await fixture();
    const a = await f.next(guarded);
    await guarded.release(a.prepared, a.finalize);
    assert.deepEqual(await guarded.resolve(a.ref, async () => true), permissions);
    outage = true;
    await assert.rejects(guarded.resolve(a.ref, async () => true), /attempt-store outage/);
    // The outage must also refuse when it lands after source authorization, not only before it.
    outage = false;
    let seen = 0;
    await assert.rejects(guarded.resolve(a.ref, async () => { seen++; outage = true; return true; }), /attempt-store outage/);
    assert.equal(seen, a.sources.length);
    outage = false;
    assert.equal(await state(a.ref), "active");
  });

  await check("foreign source coordinates and empty source sets refuse staging", async () => {
    const f = await fixture();
    const a = await f.next();
    const ref = { ...a.ref, generation: randomBytes(16).toString("hex") };
    await assert.rejects(lifecycle.stage(ref, permissions, [], a.material), /empty sources/);
    await assert.rejects(lifecycle.stage(ref, permissions, [{ ...a.sources[0], space: "foreign" }], a.material), /foreign source/);
    assert.equal(await kv.get(evidenceKey(ref)), null);
  });

  await check("modified evidence fails its attempt digest before returning permissions", async () => {
    const f = await fixture();
    const a = await f.next();
    await lifecycle.release(a.prepared, a.finalize);
    const entry = await read(kv, evidenceKey(a.ref));
    entry.value.permissions.publish = requestedSubjectPermission([">"]);
    await kv.update(evidenceKey(a.ref), JSON.stringify(entry.value), entry.revision);
    await assert.rejects(lifecycle.resolve(a.ref, live), /evidence digest/);
  });

  await check("source index payload cannot redirect retirement to another source", async () => {
    const f = await fixture();
    const a = await f.next();
    const source = await f.freeze();
    const key = sourceIndexKey(source, a.ref);
    const entry = await read(kv, key);
    entry.value.source.key = "gate.foreign";
    await kv.update(key, JSON.stringify(entry.value), entry.revision);
    await assert.rejects(lifecycle.retireSource(source), /coordinate mismatch/);
    assert.equal(await state(a.ref), "prepared");
  });

  await check("agent fixture expiry is live under the credential reader millisecond clock", async () => {
    const f = await fixture();
    const a = await f.next();
    const token: ValidatedUserToken = {
      owner: a.ref.owner, space, scope: [], ver: USER_TOKEN_VER, exp: Math.floor(Date.now() / 1000) + 300,
      act: { owner: a.ref.owner, actor: a.ref.actor, lifecycleUid: a.ref.uid, credentialId: a.mint.credentialId },
    };
    // A direct reader fixture, without signature or callout admission claims.
    await authorizeConnectCredential(reader, token, Date.now);
  });

  const keys = await generateKeyPair("EdDSA");
  const owner = deriveOwnerToken("prototype-secret".repeat(3), "root-proof-owner");
  const issuer = "https://issuer.example.test";
  async function rootFixture(hooks: { beforeCredentialFence?: (source: SourceRef) => Promise<void>; afterCredentialFence?: (source: SourceRef, ref: IssuedRef) => Promise<void> } = {}) {
    const actor = `root${++fixtureNumber}`;
    const activated = await activateLifecycle(reg, { owner, actor, managerInstance: "issuer-proof" });
    const uid = activated.mapping.lifecycleUid;
    const args = { owner, actor, lifecycleUid: uid, managerInstance: "issuer-proof" };
    const credentialId = await ensureRootCredential(reg, args);
    assert.equal(await ensureRootCredential(reg, args), credentialId);
    const ledgerKey = credRowKey(uid, credentialId);
    const ledgerEntry = await read(authKv, ledgerKey);
    const ledger = ledgerEntry.value;
    const seconds = Math.floor(Date.now() / 1000);
    const bearer = await new SignJWT({
      scope: [], ver: USER_TOKEN_VER,
      act: { owner, actor, lifecycleUid: uid, credentialId },
    }).setProtectedHeader({ alg: "EdDSA" }).setSubject(owner).setAudience(space)
      .setIssuer(issuer).setIssuedAt(seconds).setNotBefore(seconds).setExpirationTime(seconds + 300).sign(keys.privateKey);
    const token = await validateUserToken(bearer, { key: keys.publicKey, issuer, audience: space });
    let clock = Date.now();
    const now = () => clock;
    await authorizeConnectCredential(reader, token, now);
    const mint = await stageAgentMint(reg, {
      lifecycleUid: uid, credentialId, holderPrincipal: `${owner}.${actor}`, sourceChain: ["root"], exp: ledger.exp,
    });
    const ref = { space, owner, actor, uid, generation: randomBytes(16).toString("hex") };
    const credentialSource = { space, bucket: epAuthBucket(space), key: ledgerKey };
    const headSource = { space, bucket: recordsBucket(space), key: lifecycleHeadKey(owner, actor) };
    const gateSources = mint.pins.map((pin) => ({ space, bucket: epAuthBucket(space), key: pin.key }));
    const sources = [...gateSources, credentialSource, headSource];
    const credentialFence = await prepareCredentialReleaseFence(authKv, uid, credentialId);
    const prepared = await lifecycle.stage(ref, permissions, sources, "synthetic-root-result");
    await lifecycle.release(prepared, async () => {
      await credentialFence.finalize(async () => {
        await authorizeConnectCredential(reader, token, now);
        await hooks.beforeCredentialFence?.(credentialSource);
        await finalizeAgentMint(reg, mint);
      });
      await hooks.afterCredentialFence?.(credentialSource, ref);
    });
    return {
      ref, credentialSource, headSource, ledger, token, credentialRevision: ledgerEntry.revision,
      setNow(value: number) { clock = value; },
      async sourceIsLive(source: SourceRef) {
        if (!sources.some((expected) => sourcePrefix(expected) === sourcePrefix(source)))
          throw new Error("unrecognized credential source coordinate");
        // Current-source resolution remains separate from the release CAS above.
        await authorizeConnectCredential(reader, token, now);
        if (gateSources.some((expected) => sourcePrefix(expected) === sourcePrefix(source))) return live(source);
        return true;
      },
    };
  }

  await check("signed root provenance resolves through the real credential and head reader", async () => {
    const a = await rootFixture();
    assert.deepEqual(await lifecycle.resolve(a.ref, a.sourceIsLive), permissions);
    const releasedRow = await read(authKv, a.credentialSource.key);
    assert.deepEqual(releasedRow.value, a.ledger);
    assert.ok(releasedRow.revision > a.credentialRevision);
    for (const source of [a.credentialSource, a.headSource]) {
      assert.deepEqual((await read(kv, sourceIndexKey(source, a.ref))).value, { source, ref: a.ref });
    }
  });

  await check("individual root revocation denies active evidence before its index walk", async () => {
    const a = await rootFixture();
    await markLedgerRowRevoked(authKv, a.credentialSource.key);
    assert.equal(await state(a.ref), "active");
    await assert.rejects(lifecycle.resolve(a.ref, a.sourceIsLive), /revoked/);
    assert.equal(await lifecycle.retireSource(a.credentialSource), 1);
    assert.equal(await state(a.ref), "revoked");
  });

  await check("a mismatched root head denies evidence even while its credential remains active", async () => {
    const a = await rootFixture();
    const head = await read(recordsKv, a.headSource.key);
    // Operator-injected inconsistent state, not a supported root-rotation operation.
    head.value.currentCredentialId = "foreignroot";
    await recordsKv.update(a.headSource.key, JSON.stringify(head.value), head.revision);
    assert.equal((await read(authKv, a.credentialSource.key)).value.state, "active");
    await assert.rejects(lifecycle.resolve(a.ref, a.sourceIsLive), /superseded root/);
    assert.equal(await lifecycle.retireSource(a.headSource), 1);
    assert.equal(await state(a.ref), "revoked");
  });

  await check("an expired credential row denies otherwise active issued evidence", async () => {
    const a = await rootFixture();
    a.setNow(a.ledger.exp + 1);
    await assert.rejects(lifecycle.resolve(a.ref, a.sourceIsLive), /expired/);
    assert.equal(await state(a.ref), "active");
  });

  await check("the credential-source adapter refuses unrelated source coordinates", async () => {
    const a = await rootFixture();
    await assert.rejects(a.sourceIsLive({ ...a.credentialSource, key: "cred.foreign.row" }), /unrecognized/);
  });

  await check("individual revocation between validation and finalization prevents release", async () => {
    let revoked = false;
    await assert.rejects(rootFixture({
      beforeCredentialFence: async (source) => {
        await markLedgerRowRevoked(authKv, source.key);
        revoked = true;
      },
    }), /credential source fence/);
    assert.equal(revoked, true);
  });

  await check("credential revoke after its fence aborts prepared activation through the index", async () => {
    let walked = false;
    await assert.rejects(rootFixture({
      afterCredentialFence: async (source, ref) => {
        await markLedgerRowRevoked(authKv, source.key);
        assert.equal(await lifecycle.retireSource(source), 1);
        assert.equal(await state(ref), "aborted");
        walked = true;
      },
    }), isCasLoss);
    assert.equal(walked, true);
  });

  await check("issued state survives a broker process kill and restart", async () => {
    // The reopen cell above proves object-restart survival. This one kills the server process and
    // brings it back on the same file store, which is a different claim.
    const f = await fixture();
    const a = await f.next();
    await lifecycle.release(a.prepared, a.finalize);
    releaseBroker();
    broker.kill("SIGKILL");
    await exited;
    ({ child: broker, exited } = spawnBroker());
    releaseBroker = teardownOnSignal(broker, dir);
    let back = false;
    for (let i = 0; i < 100 && !back; i++) { back = await isReachable(server); if (!back) await wait(50); }
    assert.ok(back, "the broker must come back on the same store");
    const revived = await connect({ servers: `nats://127.0.0.1:${port}`, user: "issuer", pass: "synthetic-proof", maxReconnectAttempts: 0 });
    try {
      const reopened = await openIssuedLifecycle(await new Kvm(revived).open(`cotal_issued_${space}`), space);
      assert.deepEqual(await reopened.resolve(a.ref, async () => true), permissions);
      assert.equal(await reopened.retire(a.ref), "revoked");
    } finally { await revived.close(); }
  });

  console.log(`issued authority lifecycle prototype: ${passed} passed`);
} finally {
  await nc?.close();
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), wait(2000).then(() => false)]);
  if (!stopped) { broker.kill("SIGKILL"); await exited; }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
