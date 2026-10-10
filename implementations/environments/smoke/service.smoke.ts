import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { awaitBrokerReady, freePort, teardownOnSignal, killAndAwaitExit, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { contractDigest, isReachable, type EnvironmentProvisionDriver, type EnvironmentProvisionProfile, type EnvironmentObservation } from "@cotal-ai/core";
import { EnvironmentService, environmentKvStore, environmentCommandDefs, type EnvironmentHost } from "../src/index.js";

const directory = await mkdtemp(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", directory], { stdio: "ignore" });
const release = teardownOnSignal(broker, directory);
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 60, delayMs: 50 });
  nc = await connect({ servers });
  const kvm = new Kvm(nc);
  const kv = await kvm.create("environment_test", { history: 1, ttl: 0, storage: "file", allow_direct: false });
  const jsm = await jetstreamManager(nc);
  await jsm.streams.update("KV_environment_test", { allow_rollup_hdrs: false });
  const store = await environmentKvStore(kv);
  const caller = { owner: "u_owner", actor: "caller", uid: "a".repeat(26) };
  const profile: EnvironmentProvisionProfile = {
    name: "test", provider: "test", image: "immutable", resources: { cpus: 1, memoryMiB: 128, diskGiB: 5 },
    maxDurationMs: 60_000, providerOptions: {},
  };
  let creates = 0, destroys = 0, retires = 0;
  let failCreate = false, failInspect = false, failRetire = false;
  let state: EnvironmentObservation["state"] = "running";
  let holdCreate: Promise<void> = Promise.resolve();
  const driver: EnvironmentProvisionDriver = {
    name: "test", validate() {}, close() {},
    async create() { creates++; await holdCreate; if (failCreate) throw new Error("untrusted provider secret"); return { kind: "test", id: `provider-${creates}` }; },
    async inspect(environment) { if (failInspect) throw new Error("untrusted provider secret"); return { environment, state, observedAt: Date.now() }; },
    async destroy() { destroys++; },
  };
  const host: EnvironmentHost = {
    async authorize(c) { return c.owner === caller.owner; },
    async retainAndRetire(record) { retires++; assert.ok(record.environment); if (failRetire) throw new Error("retain unavailable"); return `receipt:${record.id}`; },
  };
  const service = () => new EnvironmentService(store, [profile], [driver], host);
  const args = { operationId: "create-positive-0001", profile: profile.name, profileDigest: contractDigest(profile) };
  const first = await service().create(caller, args);
  assert.equal(first.observation?.state, "running");
  const id = first.record.id;
  const repeated = await Promise.all(Array.from({ length: 8 }, () => service().create(caller, args)));
  assert.ok(repeated.every((v) => v.record.environment?.id === first.record.environment?.id));
  assert.equal(creates, 1, "same operation never creates another environment after service restart");
  await assert.rejects(() => service().inspect({ ...caller, uid: "b".repeat(26) }, id), /not found/);
  await assert.rejects(() => service().destroy({ ...caller, owner: "u_foreign" }, id), /not found/);
  await assert.rejects(() => service().create({ ...caller, owner: "u_foreign" }, args), /not authorized/);
  await assert.rejects(() => service().create(caller, { ...args, profileDigest: `sha256:${"a".repeat(64)}` }), /digest changed/);
  assert.equal(destroys, 0);
  failRetire = true;
  await assert.rejects(() => service().destroy(caller, id), /retain unavailable/);
  assert.equal(destroys, 0, "failed result retention/authority retirement prevents provider close");
  failRetire = false;
  state = "paused";
  const paused = await service().destroy(caller, id);
  assert.equal(paused.observation?.state, "paused");
  assert.equal(paused.record.terminatedAt, undefined, "PAUSED and close acknowledgement are not termination");
  failInspect = true;
  const missing = await service().inspect(caller, id);
  assert.equal(missing.problem, "observation-unavailable");
  assert.equal(missing.record.terminatedAt, undefined);
  assert.ok(!JSON.stringify(missing).includes("untrusted provider secret"));
  failInspect = false;
  state = "terminated";
  const retired = retires;
  const problems: string[] = [];
  await service().reconcile((_, problem) => problems.push(problem));
  assert.deepEqual(problems, []);
  assert.ok((await service().inspect(caller, id)).record.terminatedAt);
  assert.equal(retires, retired, "persisted retirement receipt survives service recreation");
  const destroyed = destroys;
  await service().destroy(caller, id);
  assert.equal(destroys, destroyed, "terminal cleanup is idempotent");

  failCreate = true;
  const uncertainArgs = { ...args, operationId: "create-uncertain-01" };
  const uncertain = await service().create(caller, uncertainArgs);
  assert.equal(uncertain.problem, "create-unconfirmed");
  failCreate = false;
  await service().create(caller, uncertainArgs);
  assert.equal(creates, 2, "unknown create stays held across a restart");

  let unblock!: () => void;
  holdCreate = new Promise<void>((resolve) => { unblock = resolve; });
  const racingArgs = { ...args, operationId: "create-concurrent-01" };
  const inflight = service().create(caller, racingArgs);
  // Wait for the real provider boundary, not an assumed amount of scheduling time.
  for (let i = 0; creates < 3 && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(creates, 3);
  const pending = await service().create(caller, racingArgs);
  assert.equal(pending.problem, "create-unconfirmed");
  await service().destroy(caller, pending.record.id);
  unblock();
  const bound = await inflight;
  assert.equal(bound.record.destroyRequested, true, "late provider binding preserves concurrent destruction intent");
  holdCreate = Promise.resolve();
  state = "terminated";
  await service().reconcile(() => {});
  assert.ok((await service().inspect(caller, pending.record.id)).record.terminatedAt);

  const shortProfile = { ...profile, name: "short", maxDurationMs: 1 };
  const shortService = new EnvironmentService(store, [shortProfile], [driver], host);
  const expiring = await shortService.create(caller, { operationId: "expiry-without-caller", profile: shortProfile.name, profileDigest: contractDigest(shortProfile) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The reconstructed host no longer needs the original profile to retire an expired binding.
  await service().reconcile(() => {});
  assert.ok((await service().inspect(caller, expiring.record.id)).record.terminatedAt, "expiry cleanup completes without a caller or original profile");

  const defs = environmentCommandDefs(service());
  const create = defs.find((d) => d.command === "create")!;
  assert.equal(create.contract.input.validate({ ...args, owner: "forged" }), false);
  assert.equal(create.contract.output.validate(first), true);
  // Deleted records must remain a visible failure, not turn into a second create.
  await kv.delete(`environment.${uncertain.record.id}`);
  await assert.rejects(() => service().create(caller, uncertainArgs), /deletion is corruption/);
  await assert.rejects(async () => { for await (const _ of store.records()) { /* exhaust marker-preserving scan */ } }, /deletion is corruption/);
  assert.equal(creates, 4);
  console.log("PASS environment lifecycle over real JetStream; provider is a deterministic stand-in");
} finally {
  await nc?.close();
  await killAndAwaitExit(broker);
  release();
  await rm(directory, { recursive: true, force: true });
}
