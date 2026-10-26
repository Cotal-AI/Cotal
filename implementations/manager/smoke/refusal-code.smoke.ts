// Refusal codes through the built Manager's public startAgent and described wire commands.
// A registered custody runtime refuses before acceptance. No agent process is launched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  DEV_OWNER, EpEnvelopeError, invokeCommand, lifecycleBlocked, mintLifecycleUid, newIdentity,
  registry, renderLifecycleBlocked, resolveService, type Connector, type ControlReply, type EpErrorCode, type RuntimeProvider,
  isReachable, type RuntimeReference,
} from "@cotal-ai/core";
import {
  SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, freePort, killAndAwaitExit, teardownOnSignal,
} from "@cotal-ai/smoke-kit";

const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}refusal-code-`));
process.env.COTAL_HOME = join(root, "home");
// Import the built public package after isolating its machine-local state.
const { Manager } = await import("../dist/index.js");
const workspaceRoot = join(root, "workspace");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(join(workspaceRoot, ".cotal", "agents", "worker.md"), "---\nname: worker\n---\n");

let refusal: unknown;
let reservations = 0;
let launches = 0;
let refuseReservation = true;
registry.register({
  kind: "runtime", name: "refusal-code", available: () => true,
  create: () => ({
    kind: "refusal-code",
    reserve(): RuntimeReference {
      reservations++;
      if (refuseReservation) throw refusal;
      return { kind: "refusal-code", id: mintLifecycleUid() };
    },
    async reap() { throw new Error("a refused reservation has no custody to reap"); },
    spawn() { launches++; throw new Error("a refused reservation must not launch"); },
  }),
} as RuntimeProvider);
registry.register({
  kind: "connector", name: "refusal-code", requires: ["node"],
  buildLaunch() { throw new Error("a refused reservation must not build a launch"); },
} as Connector);

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = "refusal-code";
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(root, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker);
const manager = new Manager({ space, servers, workspaceRoot, runtime: "refusal-code" });
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let passed = 0;
let failed = 0;
async function cell(name: string, check: () => void | Promise<void>) {
  try { await check(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 60, delayMs: 100 });
  await manager.start();
  nc = await connect({ servers, maxReconnectAttempts: 0 });
  const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
  const service = await resolveService(nc, space, "manager", caller);
  const wire = async (command: string, args?: Record<string, unknown>) =>
    (await invokeCommand(nc!, space, service, command, args, {})).reply;
  const blocked = lifecycleBlocked("permission-denied", "the issuance gate is retired", {
    blockedOp: "activation", gateState: "retired", opId: "refusal-op", remedy: "retry",
  });
  const revokedProxy = Proxy.revocable({}, {});
  revokedProxy.revoke();
  const cases = [
    { name: "permission-denied", error: new EpEnvelopeError("permission-denied", "credential family retired"), code: "permission-denied" },
    { name: "lifecycle-blocked", error: blocked, code: "permission-denied" },
    { name: "extension-code", error: new EpEnvelopeError("org.example.refused" as EpErrorCode, "runtime policy refused"), code: "org.example.refused" },
    { name: "failed-precondition control", error: new EpEnvelopeError("failed-precondition", "capacity reached"), code: "failed-precondition" },
    { name: "plain Error control", error: new Error("runtime unavailable"), code: undefined },
    { name: "unreadable rejection control", error: revokedProxy.proxy, code: undefined },
  ];
  for (const test of cases) {
    refusal = test.error;
    const message = test.error === revokedProxy.proxy ? "an unreadable rejection" : renderLifecycleBlocked((test.error as Error).message, test.error);
    const details = test.error === blocked ? blocked.details : undefined;
    await cell(`startAgent ${test.name} retains code, rendered message and details`, async () => {
      const before = reservations;
      const reply = await manager.startAgent({ name: "worker", agent: "refusal-code", events: false });
      assert.equal(reservations, before + 1, "public startAgent reaches runtime.reserve");
      assert.equal(reply.ok, false);
      assert.equal(reply.error, message);
      assert.deepEqual(reply.details, details);
      assert.equal(reply.code, test.code);
    });
    for (const command of ["spawn", "launch"] as const) {
      await cell(`${command} ${test.name} retains the refusal on the wire`, async () => {
        const before = reservations;
        const args = command === "spawn" ? { name: "worker", agent: "refusal-code", events: false } : {
          runId: "refusal-run", name: "worker", spec: {
            apiVersion: "cotal-launch/v1", space, runId: "refusal-run",
            agents: [{ name: "worker", agent: "refusal-code", events: false, subscribe: [], allowSubscribe: [], allowPublish: [], hash: "refusal" }],
          },
        };
        const reply = await wire(command, args);
        assert.equal(reservations, before + 1, "described command reaches runtime.reserve");
        assert.equal(reply.ok, false);
        assert.equal(reply.error?.message, message);
        assert.deepEqual(reply.error?.details, details);
        assert.equal(reply.error?.code, test.code ?? "failed-precondition");
        assert.equal(reply.error?.outcome, undefined, "reservation refusal does not invent rollback proof");
      });
    }
  }

  // Exercise the actual enrollment/staged-secret cleanup path without rebuilding a hosted
  // authority stack. This fixture switches only the mode and host callbacks on the already
  // started open manager, then restores them before shutdown. It is not hosted-auth admission
  // coverage. A host callback that refuses returns no material and creates no remote grant.
  await import("@cotal-ai/auth"); // register the real provider used by enrollUserAgent
  const hostState = manager as unknown as {
    userMode: boolean;
    remoteAuthority: { owner: string; authorizeAdmin(): Promise<boolean>; enrollManagedAgent(): Promise<never> } | undefined;
  };
  const savedMode = hostState.userMode;
  const savedAuthority = hostState.remoteAuthority;
  const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  let enrollments = 0;
  const enrollmentDetails = [{ kind: "org.example.enrollment-refusal", retryable: false }];
  try {
    refuseReservation = false;
    hostState.userMode = true;
    hostState.remoteAuthority = {
      owner,
      authorizeAdmin: async () => true,
      enrollManagedAgent: async () => { enrollments++; throw refusal; },
    };
    for (const test of [
      { name: "permission-denied", error: new EpEnvelopeError("permission-denied", "enrollment retired", enrollmentDetails, "not-executed"), code: "permission-denied" },
      { name: "conflict", error: new EpEnvelopeError("conflict", "enrollment held", enrollmentDetails, "not-executed"), code: "conflict" },
      { name: "unproven envelope control", error: new EpEnvelopeError("permission-denied", "enrollment outcome unknown"), code: undefined },
      { name: "plain Error control", error: new Error("enrollment unavailable"), code: undefined },
    ]) {
      refusal = test.error;
      const expectedError = `agent auth preflight failed for "worker": ${test.error.message}`;
      const expectedDetails = test.code === undefined ? undefined : enrollmentDetails;
      await cell(`startAgent enrollment ${test.name} retains classified refusal`, async () => {
        const before = enrollments;
        const reply = await manager.startAgent({ name: "worker", agent: "refusal-code", events: false });
        assert.equal(enrollments, before + 1, "public startAgent reaches host enrollment");
        assert.equal(reply.ok, false);
        assert.equal(reply.error, expectedError);
        assert.equal(reply.code, test.code);
        assert.deepEqual(reply.details, expectedDetails);
      });
      for (const command of ["spawn", "launch"] as const) {
        await cell(`${command} enrollment ${test.name} keeps classification and outcome`, async () => {
          const before = enrollments;
          const args = command === "spawn" ? { name: "worker", agent: "refusal-code", events: false } : {
            runId: "enrollment-refusal", name: "worker", spec: {
              apiVersion: "cotal-launch/v1", space, owner, runId: "enrollment-refusal",
              agents: [{ name: "worker", agent: "refusal-code", events: false, subscribe: [], allowSubscribe: [], allowPublish: [], hash: "enrollment" }],
            },
          };
          // launch's owner-equality check must see a user principal, not the open fixture caller.
          const userService = { ...service, caller: { ...caller, owner } };
          const reply = (await invokeCommand(nc!, space, userService, command, args, {})).reply;
          assert.equal(enrollments, before + 1, "described command reaches host enrollment");
          assert.equal(reply.ok, false);
          assert.equal(reply.error?.message, expectedError);
          assert.equal(reply.error?.code, test.code ?? "failed-precondition");
          assert.deepEqual(reply.error?.details, expectedDetails);
          assert.equal(reply.error?.outcome, test.code === undefined ? undefined : "not-executed");
        });
      }
    }
  } finally {
    hostState.userMode = savedMode;
    hostState.remoteAuthority = savedAuthority;
    refuseReservation = true;
  }

  // Non-action producers currently return uncoded refusals. Inject their ControlReply at the
  // producer only, then cross the real described models handler and envelope serialization.
  const producer = manager as unknown as { opModels(args: Record<string, unknown>): Promise<ControlReply> };
  const original = producer.opModels;
  try {
    for (const code of ["permission-denied", "org.example.refused", undefined]) {
      producer.opModels = async () => ({ ok: false, error: "catalog refused", ...(code ? { code: code as EpErrorCode } : {}), details: blocked.details });
      await cell(`non-action unwrap retains ${code ?? "uncoded compatibility"} and details`, async () => {
        const reply = await wire("models", { agent: "refusal-code" });
        assert.equal(reply.ok, false);
        assert.equal(reply.error?.message, "catalog refused");
        assert.equal(reply.error?.code, code ?? "failed-precondition");
        assert.deepEqual(reply.error?.details, blocked.details);
      });
    }
  } finally { producer.opModels = original; }
  await cell("refused reservations never launch or hold a managed agent", async () => {
    assert.equal(launches, 0);
    const reply = await wire("status");
    assert.equal(reply.ok, true);
    assert.equal((reply.data as { agentCount: number }).agentCount, 0);
  });
} finally {
  await nc?.drain();
  try { await manager.stop(); }
  finally { await killAndAwaitExit(broker); releaseBroker(); }
}

emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
