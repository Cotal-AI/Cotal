import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { createEndpointStreams, epAuthBucket, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { activateLifecycle, openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { makeLedgerScannerOverConnection } from "../src/ledger-scanner.js";
import { stageAgentMint, finalizeAgentMint, createSourceGateOpen, observeSourceGate, freezeSourceGate } from "../src/credential-ledger.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { evidenceKey, openIssuedLifecycle, sourceIndexKey, type IssuedRef, type SourceRef } from "../../../packages/core/smoke/prototypes/issued-authority-lifecycle.js";
import { requestedSubjectPermission } from "../../../packages/core/smoke/prototypes/issued-subject-permissions.js";

let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); } catch (error) { console.error(`  FAIL: ${name}`); throw error; }
  console.log(`  ok ${name}`);
  passed++;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const space = "issuedproof";
const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), `listen: 127.0.0.1:${port}\njetstream { store_dir: ${JSON.stringify(dir)} }\nauthorization { users: [{user: "issuer", password: "synthetic-proof"}] }\n`);
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const exited = new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
const releaseBroker = teardownOnSignal(broker, dir);
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
    const mintArgs = { lifecycleUid: uid, credentialId: "sharedroot", holderPrincipal: `local.${actor}`, sourceChain: [`handle.proof.${actor}`], exp: Math.floor(Date.now() / 1000) + 600 };
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
      assert.equal(await state(a.ref), "prepared");
      assert.equal(settled, false);
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

  console.log(`issued authority lifecycle prototype: ${passed} passed`);
} finally {
  await nc?.close();
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), wait(2000).then(() => false)]);
  if (!stopped) { broker.kill("SIGKILL"); await exited; }
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
