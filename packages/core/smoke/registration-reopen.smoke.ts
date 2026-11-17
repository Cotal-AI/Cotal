import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  contractDigest, DEV_OWNER, endpointRegistrationBarrier, epAuthBucket, epgateKey,
  EpEnvelopeError, isReachable, mintLifecycleUid, openRecordsBucket, parseEndpointGate,
  principalKey, provisionEndpointGateOpen, registerServiceInstance, VOID_SCHEMA,
} from "@cotal-ai/core";

// Reuse the native reopen cases from the retained #3683 regression without the unrelated
// governance suite's mutation control. Faults wrap the real KV; the broker owns every gate row.
const SPACE = "registrationreopen";
const D_VOID = contractDigest(VOID_SCHEMA);
const doc = {
  urn: "ai.cotal.reopen", revision: 1, attributes: [], events: [],
  commands: [{ name: "ping", class: "ephemeral", targeted: false, capability: "manager.call", inputDigest: D_VOID, outputDigest: D_VOID }],
};
const manifest = { v: 1, root: contractDigest(doc), members: [] as string[] };
const closure = contractDigest(manifest);
const artifacts = new Map<string, unknown>([[contractDigest(doc), doc], [closure, manifest], [D_VOID, VOID_SCHEMA]]);
const dec = new TextDecoder();
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", store, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, store);
let nc: NatsConnection | undefined;
let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, actual: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  FAIL ${name}: ${JSON.stringify(actual)}`); }
};
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await isReachable(servers), "owned broker started");
  nc = await connect({ servers });
  const kvm = new Kvm(nc);
  await kvm.create(epAuthBucket(SPACE), { history: 8 });
  const epKv = await kvm.open(epAuthBucket(SPACE));
  const recordsKv = await openRecordsBucket(nc, SPACE, { create: true });
  for (const authorized of [true, false]) {
    for (const fault of ["clean", "lost-ack", "lost-cas", "before-write"] as const) {
      const endpoint = `${authorized ? "registered" : "aborted"}${fault.replaceAll("-", "")}`;
      const instanceId = endpoint.padEnd(26, "r");
      const key = epgateKey(endpoint, instanceId);
      await provisionEndpointGateOpen(epKv, { endpoint, instanceId, principal: principalKey(DEV_OWNER, `${endpoint}gov`).key });
      let faultCalls = 0;
      const faultKv: KV = new Proxy(epKv, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "update" && typeof value === "function") {
            return async (key: string, bytes: Uint8Array, revision: number) => {
              if (JSON.parse(dec.decode(bytes)).state !== "open") return target.update(key, bytes, revision);
              faultCalls++;
              if (fault === "before-write") throw new Error("reopen transport failed before writing");
              if (fault === "lost-cas") {
                const row = await target.get(key);
                assert.ok(row);
                // A real competing write moves the revision pin; the original CAS must lose.
                await target.update(key, row.value, row.revision);
                return target.update(key, bytes, revision);
              }
              await target.update(key, bytes, revision);
              throw new Error("reopen committed on the broker; its acknowledgement was lost");
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let error: { code?: string; message: string; cause?: string } = { message: "NO THROW" };
      try {
        await registerServiceInstance(recordsKv, {
          space: SPACE, spec: { endpoint, owner: DEV_OWNER, clusterDigests: [closure], protocol: { v: 1 } },
          instanceId, registrant: { owner: DEV_OWNER },
          authority: { authorize: () => ({ authorized, revision: 0 }) },
          barrier: endpointRegistrationBarrier(fault === "clean" ? epKv : faultKv, SPACE, {
            endpoint, instanceId, opId: mintLifecycleUid(),
            evict: async (holders) => { assert.equal(holders.length, 0, "fresh fixture has no serving holders"); return []; },
          }),
          readClusterArtifact: (digest) => artifacts.get(digest),
        });
      } catch (e) {
        error = { code: (e as EpEnvelopeError).code, message: (e as Error).message, cause: ((e as { cause?: EpEnvelopeError }).cause)?.code };
      }
      const stored = await epKv.get(key);
      assert.ok(stored, "gate is read back from the broker");
      const gate = parseEndpointGate(stored.value, key);
      const actual = { error, state: gate.state, generation: gate.generation, faultCalls };
      const phase = authorized ? "Phase 4" : "abort";
      check(`${phase} ${fault}: the intended reopen boundary ran`, faultCalls === (fault === "clean" ? 0 : 1), actual);
      if (fault === "clean") {
        check(`${phase}: clean reopen retains the registration result`,
          (authorized ? error.message === "NO THROW" : error.code === "permission-denied") &&
            gate.state === "open" && gate.generation === 1, actual);
      } else {
        const outcomeMatches = fault === "lost-cas"
          ? /reopen lost its freeze token .*so this registration reopened nothing/.test(error.message)
          : /reopen's outcome is unknown: it may have committed/.test(error.message);
        const committed = fault === "lost-ack";
        check(`${phase} ${fault}: refusal agrees with independently read gate state`,
          error.code === "unavailable" && outcomeMatches && error.message.includes("re-read the gate") &&
            (authorized || error.cause === "permission-denied") &&
            gate.state === (committed ? "open" : "frozen") && gate.generation === (committed ? 1 : 0), actual);
      }
    }
  }
} finally {
  await nc?.close();
  const exited = broker.exitCode === null && broker.signalCode === null ? once(broker, "exit") : Promise.resolve();
  broker.kill("SIGKILL");
  await exited;
  releaseBroker();
  rmSync(store, { recursive: true, force: true });
}
assert.equal(passed + failed, 16, "all registration and abort cells ran");
console.log(`REGISTRATION REOPEN: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
