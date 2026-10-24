/** Retirement diagnostics through the built Manager's spawn rollback and mesh despawn doors.
 * Provisioning and runtime custody are doubles. The manager, orphan finalizer, name admission,
 * teardown, retirement requester and describe/invoke rail run unchanged against a real broker.
 * No model or workload process is launched. The fixture auth endpoint chooses each rail outcome.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  authorizeServeGrant, contractArtifactCanonicalBytes, contractDigest, contractStoreContext,
  createEndpointStreams, createSpaceAuth, EpEnvelopeError, isReachable, mintCreds,
  mintLifecycleUid, newIdentity, openRecordsBucket, publishContractArtifact, recordSpecKey,
  RECORD_KINDS, registry, serveEndpoint, setupSpaceStreams,
  type AgentHandle, type Connector, type CotalEndpoint, type ControlReply, type LaunchOpts,
  type Presence,
} from "@cotal-ai/core";
import { Manager } from "@cotal-ai/manager";
import { authClusterArtifacts, authCommandDefs, authContractArtifactValues } from "../../auth/src/auth-service-contract.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}retirement-copy-`));
process.env.COTAL_HOME = join(root, "home");
const space = "retirement-copy";
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = spawn("nats-server", ["-js", "-sd", join(root, "js"), "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
const manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root });
type Target = { id: string; name: string; lifecycleUid: string };
type Hold = { target: Target; lastError?: string };
const state = manager as unknown as {
  ep: CotalEndpoint;
  userMode: boolean;
  remoteAuthority: {
    owner: string; actors: { serve: string };
    prepareAgentRetirement: () => Promise<void>;
    mintRetirementRequester: (args: { identity: ReturnType<typeof newIdentity>; target: { owner: string; actor: string; lifecycleUid: string } }) => Promise<string>;
  } | undefined;
  provisionUserAgent: (name: string, opts: { lifecycleUid: string }) => Promise<unknown>;
  runtime: { kind: string; spawn: (name: string) => AgentHandle };
  agents: Map<string, Target>;
  retiring: Map<string, Hold>;
  deprovisioningFlight: Map<string, Promise<void>>;
  retiringFlight: Map<string, Promise<void>>;
};
let nc: NatsConnection | undefined;
let serving: ReturnType<typeof serveEndpoint> | undefined;
let started = false;
let outcome: "expired" | "denied" | "throw" | "ok" = "expired";
let failLaunch = true;
let pauseNext: { entered: () => void; wait: Promise<void> } | undefined;
const issued: Target[] = [];
const requests: Array<{ lifecycleUid: string; opId: string }> = [];
const lines: string[] = [];
const originalError = console.error;
let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "ok" : "not ok"} - ${label}`);
  if (!condition) failures++;
}
async function drain(): Promise<void> {
  while (state.deprovisioningFlight.size || state.retiringFlight.size)
    await Promise.all([...state.deprovisioningFlight.values(), ...state.retiringFlight.values()]);
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const connector: Connector = {
  kind: "connector", name: "retirement-copy", requires: ["node"],
  buildLaunch: (_opts: LaunchOpts) => {
    if (failLaunch) throw new Error("fixture launch rejected after provisioning");
    return { command: "unused", args: [], env: {} };
  },
};
registry.register(connector);
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\nsubscribe: []\n---\n");
const spawnWorker = () => manager.startAgent({ name: "worker", agent: connector.name, owner, events: false });
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space });
  nc = await connect({ servers });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  await manager.start();
  started = true;
  const auth = await createSpaceAuth(space);
  const artifacts = authClusterArtifacts();
  const store = await contractStoreContext(nc, space);
  const values = [...authContractArtifactValues(), artifacts.document, artifacts.manifest];
  const byDigest = new Map(values.map((value) => [contractDigest(value), value]));
  for (const value of values) await publishContractArtifact(store, contractArtifactCanonicalBytes(value));
  const records = await openRecordsBucket(nc, space);
  const instanceId = mintLifecycleUid();
  await records.create(recordSpecKey(RECORD_KINDS.svc, ["auth", instanceId]), new TextEncoder().encode(JSON.stringify({
    endpoint: "auth", owner, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 },
  })));
  const grant = await authorizeServeGrant(records, {
    space, endpoint: "auth", instanceId, epoch: 1, holder: { owner },
    authority: { authorize: () => ({ authorized: true, revision: 1 }) },
    readProcessEpoch: () => 1, readClusterArtifact: (digest) => byDigest.get(digest),
  });
  serving = serveEndpoint(nc, space, grant, authCommandDefs({
    async retireLifecycle(ctx) {
      const target = ctx.subject.target;
      assert.ok(target?.mode === "exact");
      const args = ctx.request.args as { opId: string };
      requests.push({ lifecycleUid: target.tUid, opId: args.opId });
      const replyOutcome = outcome;
      const pause = pauseNext;
      pauseNext = undefined;
      if (pause) { pause.entered(); await pause.wait; }
      if (replyOutcome === "expired") throw new EpEnvelopeError("expired", "fixture retirement epoch changed");
      if (replyOutcome === "denied") throw new EpEnvelopeError("permission-denied", "fixture retirement refused without effects");
      return { retired: true, lifecycleUid: target.tUid, opId: args.opId, evictedPrincipals: [] };
    },
  }), { public: true }, { resolveTarget: ({ actor }) => {
    const target = issued.findLast((entry) => entry.name === actor);
    return target ? { lifecycleUid: target.lifecycleUid, mappingRevision: 1 } : undefined;
  } });
  await nc.flush();
  state.userMode = true;
  state.remoteAuthority = {
    owner, actors: { serve: "fixture_manager" },
    prepareAgentRetirement: async () => {},
    mintRetirementRequester: async ({ identity, target }) => {
      if (outcome === "throw") throw new Error("fixture retirement requester unavailable");
      return mintCreds(auth, identity, "retirement-requester", {
        retirementRequester: { owner, actor: "fixture_manager", uid: mintLifecycleUid(), target },
      });
    },
  };
  // Only the external provisioning seam is replaced. startAgent still records the orphan,
  // decides whether to hold its name, and enters the real tracked teardown from its finally.
  state.provisionUserAgent = async (name, { lifecycleUid }) => {
    issued.push({ id: `${owner}.${name}`, name, lifecycleUid });
    return { owner, lifecycleUid, files: {}, launch: { owner, actor: name, sentinelCredsPath: "unused", bearerCmd: [] } };
  };
  const actualRoster = state.ep.getRoster.bind(state.ep);
  state.ep.getRoster = () => [...actualRoster(), ...[...state.agents.values()].map((a) => ({
    card: { id: a.id, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid,
  }) as Presence)];
  state.runtime = {
    kind: "fixture",
    spawn: (name) => {
      let running = true;
      return {
        name, kind: "fixture", status: () => running ? "running" : "exited",
        stop: () => { running = false; }, waitForExit: async () => {}, interrupt: () => {},
        attach: () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} }),
      };
    },
  };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };

  // Positive control: the same entrypoint succeeds, and a real mesh despawn creates the hold.
  failLaunch = false;
  const live = await spawnWorker();
  assert.equal(live.ok, true, live.error);
  const heldTarget = issued.at(-1)!;
  const caller = { owner, actor: "cli", uid: mintLifecycleUid() };
  const { resolveService, invokeCommand } = await import("@cotal-ai/core");
  const service = await resolveService(nc, space, "manager", caller);
  const stopped = await invokeCommand(nc, space, service, "despawn", undefined, {
    target: { mode: "owner", owner, actor: "worker", lifecycleUid: heldTarget.lifecycleUid },
  });
  assert.equal(stopped.reply.ok, true, stopped.reply.error?.message);
  await drain();
  check("held retirement retains despawn wording and the retry remedy", lines.some((line) => line.startsWith("despawn worker: the despawn stopped") && line.includes("The name stays held") && line.includes("same-name spawn")));
  check("held retirement records the same error on its own hold", state.retiring.get("worker")?.lastError?.includes("fixture retirement epoch changed") === true);
  const before = issued.length;
  const blocked: ControlReply = await spawnWorker();
  await drain();
  check("held same-name spawn is refused before provisioning and re-drives retirement", !blocked.ok && blocked.error?.includes("reserved pending retirement") === true && issued.length === before && requests.length === 2);
  for (const next of ["denied", "throw"] as const) {
    outcome = next;
    lines.length = 0;
    await spawnWorker();
    await drain();
    check(`${next} held retirement keeps its despawn prefix and records its own error`,
      lines.some((line) => line === `despawn worker: ${state.retiring.get("worker")?.lastError}`));
    if (next === "denied")
      check("held refusal preserves the auth service's reason intact", state.retiring.get("worker")?.lastError === "fixture retirement refused without effects");
  }
  outcome = "ok";
  await spawnWorker();
  await drain();
  check("confirmed held retirement clears the name", !state.retiring.has("worker") && lines.includes("despawn worker: the agent's retirement completed; the name is free for reuse"));

  failLaunch = true;
  for (const next of ["expired", "denied", "throw", "ok"] as const) {
    outcome = next;
    lines.length = 0;
    const failed = await spawnWorker();
    await drain();
    const target = issued.at(-1)!;
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "fixture launch rejected after provisioning");
    assert.equal(state.retiring.has("worker"), false);
    console.log(`observed ${next} lifecycle=${target.lifecycleUid}: ${lines.join(" | ")}`);
    if (next === "ok") {
      check("confirmed orphan retirement reports no hold to clear", lines.includes(`retire worker: lifecycle ${target.lifecycleUid} retired; the name had no hold to clear`));
    } else {
      check(`${next} orphan retirement uses a lifecycle-specific retire prefix`, lines.some((line) => line.startsWith(`retire worker: lifecycle ${target.lifecycleUid}`)));
      check(`${next} orphan retirement states no hold and offers no same-name retry`, lines.some((line) => line.includes("no hold keeps the name")) && lines.every((line) => !line.includes("despawn") && !line.includes("same-name spawn")));
    }
  }
  check("each unheld same-name spawn admitted a fresh lifecycle", new Set(issued.map((target) => target.lifecycleUid)).size === 5);
  check("retirement requests retain the original lifecycle coordinates", requests.every((request) => issued.some((target) => target.lifecycleUid === request.lifecycleUid)));

  // A delayed orphan answer must not borrow a same-name successor's retirement hold.
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  pauseNext = { entered, wait };
  outcome = "expired";
  lines.length = 0;
  await spawnWorker();
  const orphan = issued.at(-1)!;
  try {
    await reached;
    failLaunch = false;
    const successor = await spawnWorker();
    assert.equal(successor.ok, true, successor.error);
    const successorTarget = issued.at(-1)!;
    outcome = "denied";
    const stoppedSuccessor = await invokeCommand(nc, space, service, "despawn", undefined, {
      target: { mode: "owner", owner, actor: "worker", lifecycleUid: successorTarget.lifecycleUid },
    });
    assert.equal(stoppedSuccessor.reply.ok, true);
    const deadline = Date.now() + 3000;
    while (!state.retiring.get("worker")?.lastError && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const successorHold = state.retiring.get("worker");
    assert.equal(successorHold?.target.lifecycleUid, successorTarget.lifecycleUid);
    const lastError = successorHold?.lastError;
    assert.equal(lastError, "fixture retirement refused without effects");
    release();
    await drain();
    check("late orphan failure names its lifecycle without claiming the successor's hold", lines.some((line) => line.startsWith(`retire worker: lifecycle ${orphan.lifecycleUid}`) && line.includes("no hold keeps the name for this lifecycle")));
    check("late orphan failure leaves the successor's hold and last error intact", state.retiring.get("worker") === successorHold && successorHold?.lastError === lastError);
    outcome = "ok";
    await spawnWorker();
    await drain();
    assert.equal(state.retiring.has("worker"), false);
  } finally { release(); }
} finally {
  console.error = originalError;
  await drain();
  if (started) {
    // Restore the original open-manager authority before stopping its own service.
    state.remoteAuthority = undefined;
    state.userMode = false;
    await manager.stop({ withAgents: true });
  }
  await serving?.stop();
  await nc?.close();
  await killAndAwaitExit(broker);
  releaseBroker();
  registry.unregister("connector", connector.name);
  console.log(`retirement-copy: ${failures} failed; fixture retained at ${root}`);
}
process.exitCode = failures ? 1 : 0;
