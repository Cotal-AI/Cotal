/**
 * The manager-side client for hosted runtime CREATE and STATUS, and the enrollment result's
 * display-only `runtimeIntent`, driven over HTTP against the REAL authority plane on a REAL broker.
 *
 * The host here is a LABELLED FIXTURE HOST (not stock, not a production platform): stock refuses
 * both runtime kinds with `unimplemented`, so a host platform intercepts them on its own route. This
 * one authenticates nothing itself (the owner is fixed) and takes the decision ONLY from the real
 * plane's `verifyManagedAgentRuntime`, then answers from a fixture intent table. What is under test
 * is the manager's half: the request it builds and the binder it applies to the host's body.
 *
 *   A. create and status round trips: SDK builder -> HTTP -> real door -> host result -> SDK binder.
 *   B. the binder refuses a host body that carries a provider handle or names another target.
 *   C. a door refusal travels back as the host's HTTP status.
 *   D. `runtimeIntent` on the enrollment result: an older host omits it, a current host sends
 *      `{ state: "reserved" }`, and neither changes the material the manager launches against.
 *
 * Run: pnpm smoke:managed-agent-runtime-client   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  createSpaceAuth, createEndpointStreams, ensureAuthorityStores, epAuthBucket, epgateKey, EpEnvelopeError,
  isReachable, mintLifecycleUid, newIdentity, parseRemoteManagedAgentRuntimeCreateRequest,
  parseRemoteManagedAgentRuntimeStatusRequest, remoteManagedAgentRuntimeResult, remoteManagerActors, serverConfig,
  type ManagedAgentRuntimeReadiness, type ManagedAgentRuntimeState, type RemoteManagedAgentEnrollmentResult,
  type RemoteManagedAgentRuntimeRequest,
} from "@cotal-ai/core";
import { userAuthStateDir } from "@cotal-ai/workspace";
import { deriveOwnerToken, grantActor, openAuthAuthorityPlane, remoteManagerCurrentRegistrationProof } from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import {
  remoteManagedAgentEnrollmentMaterial, remoteManagedAgentEnrollmentRequest,
  remoteManagedAgentRuntimeRequest, remoteManagedAgentRuntimeState,
} from "../src/remote-authority.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const throws = (name: string, fn: () => unknown, pattern: RegExp) => {
  try { fn(); check(name, false, "expected a refusal"); }
  catch (e) { check(name, e instanceof Error && pattern.test(e.message), e instanceof Error ? e.message : e); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `mrtc${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = userAuthStateDir(tmp, space);
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const EPOCH = 6;
const REVISION = 3;
const state = {
  v: 1 as const, space, instanceId: mintLifecycleUid(), lifecycleUid: mintLifecycleUid(),
  identities: { supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(), goalWriter: newIdentity(), sessionLedger: newIdentity() },
};
const publicIds = Object.fromEntries(Object.entries(state.identities).map(([n, i]) => [n, { id: i.id }])) as never;
const proof = remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, OWNER, {
  space, actor: "cli", instanceId: state.instanceId, managerLifecycleUid: state.lifecycleUid, identities: publicIds,
}, { registrationRevision: REVISION, processEpoch: EPOCH });
const TARGET = { owner: OWNER, actor: "worker", lifecycleUid: mintLifecycleUid() };

// The fixture host's intent table and the shape of its next answer. `extra` lets a cell make the
// host misbehave so the manager's binder, not the host, is what refuses.
const intents = new Map<string, ManagedAgentRuntimeState>([[TARGET.lifecycleUid, "reserved"]]);
let extra: Record<string, unknown> = {};
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let http: Server | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  {
    const { openAuthorityClient } = await import("../../auth/src/authority-client.js");
    const wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
    try {
      const kvm = new Kvm(wide.nc);
      await ensureAuthorityStores(await jetstreamManager(wide.nc), kvm, space);
      await createEndpointStreams(await jetstreamManager(wide.nc), kvm, space);
      await (await kvm.open(epAuthBucket(space))).put(epgateKey("manager", state.instanceId), new TextEncoder().encode(JSON.stringify({
        state: "open", principal: `${OWNER}.${remoteManagerActors(state.instanceId).serve}`, processEpoch: EPOCH,
        registrationRevision: REVISION, generation: 1, nameAuthorityRevision: 0,
      })));
    } finally { await wide.close(); }
  }
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: () => {} });
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "supervise"], allowSubscribe: [">"], allowPublish: [">"] });

  http = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const { request } = JSON.parse(raw) as { request: RemoteManagedAgentRuntimeRequest };
      const decision = await plane!.verifyManagedAgentRuntime({ owner: OWNER, request });
      const parsed = request.kind === "manager-managed-agent-runtime-create"
        ? parseRemoteManagedAgentRuntimeCreateRequest(request) : parseRemoteManagedAgentRuntimeStatusRequest(request);
      const current = intents.get(decision.target.lifecycleUid);
      if (!current) return send(404, { error: "not-found" });
      let next = current;
      if (parsed.kind === "manager-managed-agent-runtime-create" && current === "reserved") intents.set(decision.target.lifecycleUid, next = "creating");
      const readiness: ManagedAgentRuntimeReadiness = next === "bound" ? "bound-not-ready" : "none";
      return send(200, { ...remoteManagedAgentRuntimeResult(parsed, decision.owner, { state: next, readiness }), ...extra });
    } catch (e) {
      const code = e instanceof EpEnvelopeError ? ({ "conflict": 409, "bad-request": 400, "failed-precondition": 412 } as Record<string, number>)[e.code] ?? 403 : 403;
      return send(code, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  const httpPort = await pickFreePort();
  await new Promise<void>((r) => http!.listen(httpPort, "127.0.0.1", r));
  const post = async (request: RemoteManagedAgentRuntimeRequest) => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/fixture-host/manager-service-authority`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }),
    });
    return { status: res.status, body: await res.json() as unknown };
  };

  console.log("A. create and status round trips through the real door");
  {
    const createReq = remoteManagedAgentRuntimeRequest("manager-managed-agent-runtime-create", state, "cli", proof, EPOCH, TARGET);
    let parsedSame = false;
    try { assert.deepStrictEqual(parseRemoteManagedAgentRuntimeCreateRequest(createReq), createReq); parsedSame = true; } catch { /* reported below */ }
    check("the SDK create request passes the core closed parser unchanged", parsedSame, createReq);
    const created = await post(createReq);
    const createState = created.status === 200 ? remoteManagedAgentRuntimeState(created.body, createReq) : undefined;
    check("POSITIVE CONTROL: runtime-create moves the fixture intent reserved -> creating and binds the echo",
      createState?.state === "creating" && createState.readiness === "none" && createState.owner === OWNER, created);
    intents.set(TARGET.lifecycleUid, "bound");
    const statusReq = remoteManagedAgentRuntimeRequest("manager-managed-agent-runtime-status", state, "cli", proof, EPOCH, TARGET);
    const read = await post(statusReq);
    const statusState = read.status === 200 ? remoteManagedAgentRuntimeState(read.body, statusReq) : undefined;
    check("POSITIVE CONTROL: runtime-status reports bound / bound-not-ready",
      statusState?.state === "bound" && statusState.readiness === "bound-not-ready", read);
  }

  console.log("B. the manager's binder refuses a misbehaving host body");
  {
    const statusReq = remoteManagedAgentRuntimeRequest("manager-managed-agent-runtime-status", state, "cli", proof, EPOCH, TARGET);
    extra = { providerHandle: "prov-123" };
    const leaked = await post(statusReq);
    extra = {};
    throws("a host body carrying a provider handle is refused by the manager",
      () => remoteManagedAgentRuntimeState(leaked.body, statusReq), /unknown field "providerHandle"/);
    extra = { target: { ...TARGET, lifecycleUid: mintLifecycleUid() } };
    const swapped = await post(statusReq);
    extra = {};
    throws("a host body naming another target is refused by the manager",
      () => remoteManagedAgentRuntimeState(swapped.body, statusReq), /different lifecycle, request, owner, or target/);
  }

  console.log("C. a door refusal travels back as the host's status");
  {
    const stale = await post(remoteManagedAgentRuntimeRequest("manager-managed-agent-runtime-create", state, "cli", proof, EPOCH - 1, TARGET));
    check("a stale serve epoch is refused 409 by the real door before the host reads its table",
      stale.status === 409 && /is stale/.test(String((stale.body as { error?: string }).error)), stale);
  }

  console.log("D. runtimeIntent on the enrollment result is display-only");
  {
    const enroll = remoteManagedAgentEnrollmentRequest(state, "cli", proof, EPOCH, { actor: "worker", tokenHash: "b".repeat(64) });
    const material = {
      owner: OWNER, actor: "worker", lifecycleUid: TARGET.lifecycleUid, sentinelCreds: "sentinel",
      subscribe: [], allowSubscribe: [], allowPublish: [], agentBearerExchangeUrl: "https://host.example",
    };
    const older: RemoteManagedAgentEnrollmentResult = {
      v: 1, kind: enroll.kind, space, owner: OWNER, actor: "cli", instanceId: state.instanceId,
      managerLifecycleUid: state.lifecycleUid, requestId: enroll.requestId, registrationProof: proof, serveEpoch: EPOCH, material,
    };
    const fromOlder = remoteManagedAgentEnrollmentMaterial(older, enroll);
    check("an older host that omits runtimeIntent still enrolls", JSON.stringify(fromOlder) === JSON.stringify(material), fromOlder);
    let fromCurrent: unknown;
    try { fromCurrent = remoteManagedAgentEnrollmentMaterial({ ...older, runtimeIntent: { state: "reserved" } }, enroll); }
    catch (e) { fromCurrent = (e as Error).message; }
    check("a host that sends runtimeIntent { state: \"reserved\" } enrolls to the SAME material (never authority)",
      JSON.stringify(fromCurrent) === JSON.stringify(material), fromCurrent);
    throws("a runtimeIntent in another state is refused",
      () => remoteManagedAgentEnrollmentMaterial({ ...older, runtimeIntent: { state: "bound" } } as never, enroll), /runtimeIntent other than/);
    throws("a runtimeIntent carrying a provider handle is refused",
      () => remoteManagedAgentEnrollmentMaterial({ ...older, runtimeIntent: { state: "reserved", handle: "prov-123" } } as never, enroll), /runtimeIntent other than/);
  }
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  http?.close();
  await plane?.close().catch(() => {});
  srv.kill("SIGTERM"); // exact PID - never pkill nats-server
  await new Promise<void>((r) => { if (srv.exitCode !== null || srv.signalCode !== null) r(); else { srv.once("exit", () => r()); setTimeout(r, 3000); } });
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
}
const EXPECTED = 10;
console.log(`\nMANAGED-AGENT-RUNTIME-CLIENT SMOKE ${fail === 0 && pass + fail === EXPECTED ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed, expected ${EXPECTED})`);
process.exit(fail === 0 && pass + fail === EXPECTED ? 0 : 1);
