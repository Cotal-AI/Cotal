/** Real broker expiry during registration must resume one freeze, never skip its family. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  commitSiblingIssuance, createSpaceAuth, credentialIdOf, credsClaims, epAuthBucket,
  endpointRegistrationBarrier, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  remoteManagerActors, serverConfig, serveIssuanceGateKv, setupSpaceStreams, standaloneConnectOpts,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { registerRemoteManagerAuthority } from "../src/remote-register.js";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}registration-expiry-`));
for (const name of ["home", "config", "runtime", "cotal"]) mkdirSync(join(root, name), { mode: 0o700 });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_RUNTIME_DIR = join(root, "runtime");
process.env.COTAL_HOME = join(root, "cotal");
const space = `regexp${mintLifecycleUid().slice(0, 8)}`;
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
const config = join(root, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js") }));
const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker, root);
const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const executor = newIdentity();
const executorCreds = (ttl: number, identity = executor) => mintCreds(auth, identity, "remote-manager", {
  principal: { owner, actor: actors.executor },
  remoteManager: { instanceId, owner, actor: actors.executor }, expiresInSeconds: ttl,
});
const logged: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); originalError(...args); };
let observer: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  observer = await connect({ servers: server, ...standaloneConnectOpts({ creds: await executorCreds(120), tls: false }), maxReconnectAttempts: 0 });
  const authKv = await new Kvm(observer).open(epAuthBucket(space));
  const gate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId });
  const barrier = endpointRegistrationBarrier(authKv, space, { endpoint: "manager", instanceId, opId: instanceId });
  const base = { space, server, owner, instanceId, serveActor: actors.serve, tlsRequired: false };
  const first = await registerRemoteManagerAuthority({ ...base, prepareCreds: await executorCreds(60), evict: async holders => holders.map(() => true) });
  const sibling = newIdentity();
  const observed = (await gate.observe())!;
  for (let i = 0; i < 36; i++) {
    const creds = await mintCreds(auth, sibling, "goal-writer", {
      principal: { owner, actor: actors.goalWriter }, goalWriter: { endpoint: "manager" },
    });
    await commitSiblingIssuance(gate, (await gate.observe())!, {
      credentialId: credentialIdOf(creds), credentialKey: sibling.id,
      holderPrincipal: `${owner}.${actors.goalWriter}`, endpoint: "manager", lifecycleUid: instanceId,
      sourceChain: ["root"], state: "active", exp: credsClaims(creds).exp,
      generation: observed.generation, processEpoch: observed.processEpoch,
      registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
    });
  }
  const short = await executorCreds(5);
  const expiry = credsClaims(short).exp!;
  let evictions = 0, refreshes = 0;
  let frozenRevision: number | undefined;
  const registered = await registerRemoteManagerAuthority({ ...base, prepareCreds: short,
    refreshPrepareCreds: async () => {
      refreshes++;
      const frozen = (await gate.observe())!;
      assert.equal(frozen.state, "frozen");
      assert.equal(frozen.revision, frozenRevision);
      assert.equal(frozen.processEpoch, first.processEpoch);
      return executorCreds(60);
    },
    evict: async holders => {
      evictions++;
      const frozen = (await gate.observe())!;
      assert.equal(frozen.state, "frozen");
      frozenRevision ??= frozen.revision;
      assert.equal(frozen.revision, frozenRevision);
      assert.equal((await barrier.enumerate()).filter(row => row.state === "revoked").length, 36);
      if (evictions === 1) {
        // Expiry is enforced by the broker, not a simulated closed-connection exception.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, (expiry + 1) * 1000 - Date.now())));
      }
      return holders.map(() => true);
    },
  });
  assert.equal(refreshes, 1);
  assert.equal(evictions, 2);
  assert.equal(registered.processEpoch, first.processEpoch + 1);
  assert.equal((await gate.observe())!.generation, observed.generation + 1);
  assert.equal((await gate.observe())!.state, "open");
  assert.equal((await barrier.enumerate()).filter(row => row.state === "active").length, 0);
  assert.ok(logged.some(line => /revoked 36 of 36/.test(line)));
  assert.ok(logged.some(line => /executor expired; resuming/.test(line)));
  console.log("  ✓ broker expiry resumes the same freeze, preserves all revocations and advances one epoch");
  console.log("  ✓ registration reports numeric family progress and fresh-authority recovery");

  // A live connection's non-expiry refusal must not be hidden by the authority retry.
  await assert.rejects(registerRemoteManagerAuthority({ ...base, prepareCreds: await executorCreds(60),
    refreshPrepareCreds: async () => { throw new Error("unexpected refresh"); },
    evict: async () => { throw new Error("verified eviction refused"); },
  }), /verified eviction refused/);
  assert.equal((await gate.observe())!.state, "frozen");
  console.log("  ✓ a non-expiry failure refuses without requesting replacement authority");

  const refused = new Error("host denied prepare");
  await assert.rejects(registerRemoteManagerAuthority({ ...base, prepareCreds: short,
    refreshPrepareCreds: async () => { throw refused; }, evict: async holders => holders.map(() => true),
  }), error => error === refused);
  assert.equal((await gate.observe())!.state, "frozen");
  console.log("  ✓ a denied refresh propagates and leaves the operation frozen");

  await assert.rejects(registerRemoteManagerAuthority({ ...base, prepareCreds: short,
    refreshPrepareCreds: async () => short, evict: async holders => holders.map(() => true),
  }), /advance.*expiry/);
  await assert.rejects(registerRemoteManagerAuthority({ ...base, prepareCreds: short,
    refreshPrepareCreds: async () => executorCreds(60, newIdentity()), evict: async holders => holders.map(() => true),
  }), /same.*identity/);
  console.log("  ✓ replacement authority must advance expiry and keep the same executor identity");
} finally {
  console.error = originalError;
  await observer?.close();
  await killAndAwaitExit(broker);
  release();
}
console.log("remote-registration-expiry: 5 passed, 0 failed");
