/**
 * Hosted runtime CREATE and STATUS for an already-enrolled managed agent, driven against a REAL
 * broker and the REAL authority plane.
 *
 * The two kinds let a signerless remote participant reach a host's provider effect (create) or its
 * persisted intent (status), so the value is in the refusals. Every door cell runs through
 * `openAuthAuthorityPlane().verifyManagedAgentRuntime`: the manager gate is read over a real
 * JetStream KV, the registration proof is checked against the real data-account signing seed, and
 * the manager actor's scope is read from the real file ledger by the door itself.
 *
 *   A. the closed parsers: one cell per forbidden field (`providerRef`, `handle`, `name`) at the
 *      top level and in the target, for each kind, plus the wrong-kind and positive controls.
 *   B. runtime-create authorization, one cell per guard, each beside its positive control.
 *   C. runtime-status authorization: the same guards, because the read authenticates the manager
 *      the same way even though it authorizes no effect.
 *   D. the host result: the closed builder and the binder a manager applies to an untrusted body.
 *   E. the dispatch refusal: stock `dispatchManagerAuthorityRequest` answers `unimplemented` for
 *      both kinds rather than falling through to a manager-lifecycle phase.
 *
 * The HTTP door's own guards for these kinds run against the real daemon in remote-exchange.smoke.ts.
 *
 * Run: pnpm smoke:managed-agent-runtime:auth   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  createSpaceAuth, createEndpointStreams, ensureAuthorityStores, epAuthBucket, epgateKey,
  EpEnvelopeError, isReachable, mintLifecycleUid, newIdentity,
  parseRemoteManagedAgentRuntimeCreateRequest, parseRemoteManagedAgentRuntimeResult,
  parseRemoteManagedAgentRuntimeStatusRequest, remoteManagedAgentRuntimeResult, remoteManagerActors, serverConfig,
  type RemoteManagedAgentRuntimeCreateRequest, type RemoteManagedAgentRuntimeRequest, type RemoteManagedAgentRuntimeStatusRequest,
} from "@cotal-ai/core";
import { userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { cotalAuthProvider, deriveOwnerToken, ensurePinnedIdp, grantActor, openAuthAuthorityPlane, remoteManagerCurrentRegistrationProof } from "../src/index.js";
import { dispatchManagerAuthorityRequest } from "../src/service.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const outcome = async <T>(fn: () => Promise<T>): Promise<{ value?: T; code?: string; message?: string }> => {
  try { return { value: await fn() }; } catch (e) {
    return { code: e instanceof EpEnvelopeError ? e.code : "thrown", message: e instanceof Error ? e.message : String(e) };
  }
};
const outcomeSync = <T>(fn: () => T): { value?: T; message?: string } => {
  try { return { value: fn() }; } catch (e) { return { message: e instanceof Error ? e.message : String(e) }; }
};
const refuses = async (name: string, fn: () => Promise<unknown>, code: string, pattern: RegExp) => {
  const r = await outcome(fn);
  check(name, r.code === code && pattern.test(r.message ?? ""), r);
};
const throws = (name: string, fn: () => unknown, pattern: RegExp) => {
  try { fn(); check(name, false, "expected a refusal"); }
  catch (e) { check(name, e instanceof Error && pattern.test(e.message), e instanceof Error ? e.message : e); }
};

const space = `mrt-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = userAuthStateDir(tmp, space);
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const OTHER_OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-2");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};

const INSTANCE = mintLifecycleUid();
const MANAGER_UID = mintLifecycleUid();
const EPOCH = 4;
const REVISION = 9;
const actors = remoteManagerActors(INSTANCE);
const identities = {
  supervisor: { id: newIdentity().id },
  executor: { id: newIdentity().id },
  serve: { id: newIdentity().id },
  goalWriter: { id: newIdentity().id },
  sessionLedger: { id: newIdentity().id },
};
const FROZEN_INSTANCE = mintLifecycleUid();
const FOREIGN_INSTANCE = mintLifecycleUid();
const ABSENT_INSTANCE = mintLifecycleUid();
// The target never has a ledger row in this suite: the door decides on the MANAGER actor, so a
// status read keeps working after the target's own grant is revoked.
const TARGET_UID = mintLifecycleUid();
const TARGET = { owner: OWNER, actor: "worker", lifecycleUid: TARGET_UID };

const proofFor = (instanceId: string, actor = "cli", revision = REVISION, epoch = EPOCH, owner = OWNER) =>
  remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, owner, {
    space, actor, instanceId, managerLifecycleUid: MANAGER_UID, identities,
  }, { registrationRevision: revision, processEpoch: epoch });

const create = (overrides: Partial<RemoteManagedAgentRuntimeCreateRequest> = {}): RemoteManagedAgentRuntimeCreateRequest => ({
  v: 1,
  kind: "manager-managed-agent-runtime-create",
  space,
  actor: "cli",
  instanceId: INSTANCE,
  managerLifecycleUid: MANAGER_UID,
  requestId: `runtime${mintLifecycleUid()}`,
  registrationProof: proofFor(INSTANCE),
  serveEpoch: EPOCH,
  target: { ...TARGET },
  identities,
  ...overrides,
});
const status = (overrides: Partial<RemoteManagedAgentRuntimeStatusRequest> = {}): RemoteManagedAgentRuntimeStatusRequest => ({
  ...create(),
  kind: "manager-managed-agent-runtime-status",
  ...overrides,
});

let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let wide: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const jsm = await jetstreamManager(wide.nc);
  const kvm = new Kvm(wide.nc);
  await ensureAuthorityStores(jsm, kvm, space);
  await createEndpointStreams(jsm, kvm, space);
  const epKv = await kvm.open(epAuthBucket(space));
  const putGate = async (instanceId: string, row: { state: "open" | "frozen" | "retired"; principal: string; processEpoch: number; registrationRevision: number }) => {
    await epKv.put(epgateKey("manager", instanceId), new TextEncoder().encode(JSON.stringify({
      ...row, generation: 1, nameAuthorityRevision: 0,
      ...(row.state === "open" ? {} : { op: { opId: mintLifecycleUid(), kind: row.state === "retired" ? "retirement" : "takeover" } }),
    })));
  };
  await putGate(INSTANCE, { state: "open", principal: `${OWNER}.${actors.serve}`, processEpoch: EPOCH, registrationRevision: REVISION });
  await putGate(FROZEN_INSTANCE, { state: "frozen", principal: `${OWNER}.${remoteManagerActors(FROZEN_INSTANCE).serve}`, processEpoch: EPOCH, registrationRevision: REVISION });
  await putGate(FOREIGN_INSTANCE, { state: "open", principal: `${OTHER_OWNER}.${remoteManagerActors(FOREIGN_INSTANCE).serve}`, processEpoch: EPOCH, registrationRevision: REVISION });

  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet });
  const store = workspaceSecretStore(tmp);
  ensurePinnedIdp(dir, "http://127.0.0.1:49151/api/auth");
  await cotalAuthProvider.prepareServer({
    store, dir, space, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
  });
  // The manager actor's interactive rows. `cli` supervises; `helper` holds every OTHER manager
  // capability; `ghost` has no row at all.
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "supervise", "admin"], allowSubscribe: [">"], allowPublish: [">"] });
  grantActor(dir, { owner: OWNER, actor: "helper", scope: ["spawn", "admin"], allowSubscribe: [">"], allowPublish: [">"] });
  const decide = (request: RemoteManagedAgentRuntimeRequest, owner = OWNER) => plane!.verifyManagedAgentRuntime({ owner, request });

  console.log("A. the closed parsers");
  for (const [label, base, parse] of [
    ["runtime-create", create, parseRemoteManagedAgentRuntimeCreateRequest],
    ["runtime-status", status, parseRemoteManagedAgentRuntimeStatusRequest],
  ] as const) {
    for (const field of ["providerRef", "handle", "name"]) {
      throws(`${label} refuses a top-level ${field}`,
        () => parse({ ...base(), [field]: "prov-123" }), new RegExp(`carries unknown field "${field}"`));
      throws(`${label} refuses target.${field}`,
        () => parse({ ...base(), target: { ...TARGET, [field]: "prov-123" } }), new RegExp(`target carries unknown field "${field}"`));
    }
    throws(`${label} refuses a target with no lifecycleUid`,
      () => parse({ ...base(), target: { owner: OWNER, actor: "worker" } }), /target must be exactly/);
    const parsed = parse(base());
    check(`POSITIVE CONTROL: a well-formed ${label} parses and retains only the closed fields`,
      Object.keys(parsed).sort().join(",") === ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "target", "identities"].sort().join(",") &&
      Object.keys(parsed.target).sort().join(",") === "actor,lifecycleUid,owner",
      parsed);
  }
  throws("runtime-create refuses a request whose kind is runtime-status",
    () => parseRemoteManagedAgentRuntimeCreateRequest(status()), /must carry \{ v: 1, kind: "manager-managed-agent-runtime-create" \}/);
  throws("runtime-status refuses a request whose kind is runtime-create",
    () => parseRemoteManagedAgentRuntimeStatusRequest(create()), /must carry \{ v: 1, kind: "manager-managed-agent-runtime-status" \}/);
  await refuses("the door refuses a top-level providerRef as bad-request before any check",
    () => decide({ ...create(), providerRef: "prov-123" } as never), "bad-request", /unknown field "providerRef"/);

  console.log("B. runtime-create authorization, against the real gate, proof secret, and ledger");
  {
    const ok = await outcome(() => decide(create()));
    check("POSITIVE CONTROL: runtime-create decides exactly { owner, instanceId, actor, target }",
      ok.value !== undefined && Object.keys(ok.value).sort().join(",") === "actor,instanceId,owner,target" &&
      ok.value.owner === OWNER && ok.value.instanceId === INSTANCE && ok.value.actor === "cli" &&
      JSON.stringify(ok.value.target) === JSON.stringify(TARGET), ok);
    await refuses("runtime-create: an owner with no ledger grant for the manager actor is refused",
      () => decide(create({ actor: "ghost", registrationProof: proofFor(INSTANCE, "ghost") })), "permission-denied", /no ledger grant for the manager actor/);
    await refuses('runtime-create: a manager row without "supervise" is refused even holding spawn and admin',
      () => decide(create({ actor: "helper", registrationProof: proofFor(INSTANCE, "helper") })), "permission-denied", /scope "supervise"/);
    await refuses("runtime-create: a request naming another host space is refused",
      () => decide(create({ space: "other" })), "permission-denied", /not host space/);
    await refuses("runtime-create: a target owner that is not the authenticated owner is refused",
      () => decide(create({ target: { ...TARGET, owner: OTHER_OWNER } })), "permission-denied", /does not match authenticated owner/);
    await refuses("runtime-create: an instance with no gate at all is refused",
      () => decide(create({ instanceId: ABSENT_INSTANCE, registrationProof: proofFor(ABSENT_INSTANCE) })), "failed-precondition", /no current open manager gate/);
    await refuses("runtime-create: a FROZEN gate is refused",
      () => decide(create({ instanceId: FROZEN_INSTANCE, registrationProof: proofFor(FROZEN_INSTANCE) })), "failed-precondition", /no current open manager gate/);
    await refuses("runtime-create: a gate held by another owner's serve principal is refused",
      () => decide(create({ instanceId: FOREIGN_INSTANCE, registrationProof: proofFor(FOREIGN_INSTANCE) })), "permission-denied", /not serve principal/);
    await refuses("runtime-create: a stale serve epoch is refused as a conflict",
      () => decide(create({ serveEpoch: EPOCH - 1, registrationProof: proofFor(INSTANCE, "cli", REVISION, EPOCH - 1) })), "conflict", new RegExp(`epoch ${EPOCH - 1} is stale; current is ${EPOCH}`));
    await refuses("runtime-create: a forged registration proof is refused",
      () => decide(create({ registrationProof: `sha256:${"f".repeat(64)}` })), "permission-denied", /does not match current host registration/);
    await refuses("runtime-create: a proof for a superseded registration revision is refused",
      () => decide(create({ registrationProof: proofFor(INSTANCE, "cli", REVISION - 1) })), "permission-denied", /does not match current host registration/);
  }

  console.log("C. runtime-status authorization: the same manager authentication, no effect");
  {
    const ok = await outcome(() => decide(status()));
    check("POSITIVE CONTROL: runtime-status decides exactly { owner, instanceId, actor, target }",
      ok.value !== undefined && Object.keys(ok.value).sort().join(",") === "actor,instanceId,owner,target" &&
      ok.value.owner === OWNER && ok.value.instanceId === INSTANCE && JSON.stringify(ok.value.target) === JSON.stringify(TARGET), ok);
    await refuses("runtime-status: an owner with no ledger grant for the manager actor is refused",
      () => decide(status({ actor: "ghost", registrationProof: proofFor(INSTANCE, "ghost") })), "permission-denied", /no ledger grant for the manager actor/);
    await refuses('runtime-status: a manager row without "supervise" is refused',
      () => decide(status({ actor: "helper", registrationProof: proofFor(INSTANCE, "helper") })), "permission-denied", /scope "supervise"/);
    await refuses("runtime-status: a target owner that is not the authenticated owner is refused",
      () => decide(status({ target: { ...TARGET, owner: OTHER_OWNER } })), "permission-denied", /does not match authenticated owner/);
    await refuses("runtime-status: a FROZEN gate is refused",
      () => decide(status({ instanceId: FROZEN_INSTANCE, registrationProof: proofFor(FROZEN_INSTANCE) })), "failed-precondition", /no current open manager gate/);
    await refuses("runtime-status: a stale serve epoch is refused as a conflict",
      () => decide(status({ serveEpoch: EPOCH + 1, registrationProof: proofFor(INSTANCE, "cli", REVISION, EPOCH + 1) })), "conflict", new RegExp(`epoch ${EPOCH + 1} is stale; current is ${EPOCH}`));
    await refuses("runtime-status: a forged registration proof is refused",
      () => decide(status({ registrationProof: `sha256:${"f".repeat(64)}` })), "permission-denied", /does not match current host registration/);
  }

  console.log("D. the host result and the binder a manager applies to it");
  {
    const request = parseRemoteManagedAgentRuntimeStatusRequest(status());
    const built = remoteManagedAgentRuntimeResult(request, OWNER, { state: "bound", readiness: "bound-not-ready", retirementPhase: "released" });
    const bound = parseRemoteManagedAgentRuntimeResult(JSON.parse(JSON.stringify(built)), request);
    check("POSITIVE CONTROL: a host result round-trips through the binder with its retirementPhase",
      bound.state === "bound" && bound.readiness === "bound-not-ready" && bound.retirementPhase === "released" && bound.owner === OWNER, bound);
    const noPhase = parseRemoteManagedAgentRuntimeResult(remoteManagedAgentRuntimeResult(request, OWNER, { state: "reserved", readiness: "none" }), request);
    check("a result without retirementPhase stays without one", !("retirementPhase" in noPhase), noPhase);
    throws("the binder refuses a result that carries a provider handle",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, providerHandle: "prov-123" }, request), /unknown field "providerHandle"/);
    throws("the binder refuses a result naming another owner",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, owner: OTHER_OWNER }, request), /different lifecycle, request, owner, or target/);
    throws("the binder refuses a result for another target",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, target: { ...TARGET, lifecycleUid: mintLifecycleUid() } }, request), /different lifecycle, request, owner, or target/);
    // Property order is not part of the closed schema: a host may serialize the target in any order.
    const reordered = { lifecycleUid: TARGET.lifecycleUid, actor: TARGET.actor, owner: TARGET.owner };
    const reorderedOk = outcomeSync(() => parseRemoteManagedAgentRuntimeResult({ ...built, target: reordered }, request));
    check("the binder accepts a result whose target carries the same owner, actor and lifecycleUid in another key order",
      reorderedOk.value?.state === "bound" && reorderedOk.value.target.owner === OWNER &&
        reorderedOk.value.target.actor === TARGET.actor && reorderedOk.value.target.lifecycleUid === TARGET.lifecycleUid, reorderedOk);
    throws("the binder refuses a result whose target carries an extra key",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, target: { ...reordered, handle: "prov-123" } }, request), /different lifecycle, request, owner, or target/);
    throws("the binder refuses a result whose target is missing a key",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, target: { owner: TARGET.owner, actor: TARGET.actor } }, request), /different lifecycle, request, owner, or target/);
    throws("the binder refuses a state outside the closed set",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, state: "running" }, request), /state must be one of/);
    throws("the binder refuses a readiness outside the closed set",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, readiness: "unknown" }, request), /readiness must be one of/);
    throws("the binder refuses a retirementPhase outside the closed set",
      () => parseRemoteManagedAgentRuntimeResult({ ...built, retirementPhase: "gone" }, request), /retirementPhase must be one of/);
  }

  console.log("E. the stock dispatch refusal");
  {
    const wrongArm = async () => { throw new Error("wrong dispatcher arm"); };
    const ctx = {
      space, dir, secrets: store,
      managerServiceAuthority: wrongArm as never,
      maintainRemoteManager: wrongArm as never,
      validateRetainedAgent: wrongArm as never,
      enrollManagedAgent: wrongArm as never,
      prepareManagedAgentRetirement: wrongArm as never,
      scanManagerGoalIndex: wrongArm as never,
      authorizeManagerAdmin: wrongArm as never,
      admitManagerRun: wrongArm as never,
      issueManagerRunAttempt: wrongArm as never,
    };
    await refuses("dispatch refuses a runtime-create request with unimplemented",
      () => dispatchManagerAuthorityRequest(ctx, OWNER, { request: create() }),
      "unimplemented", /runtime create and status must be handled by host platform interception/);
    await refuses("dispatch refuses a runtime-status request with unimplemented",
      () => dispatchManagerAuthorityRequest(ctx, OWNER, { request: status() }),
      "unimplemented", /runtime create and status must be handled by host platform interception/);
  }
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await wide?.close().catch(() => {});
  srv.kill("SIGTERM"); // exact PID - never pkill nats-server
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
}
// Counts, not just "no failures": a cell that stops running stops protecting anything.
const EXPECTED = 50;
console.log(`\nMANAGED-AGENT-RUNTIME SMOKE ${fail === 0 && pass + fail === EXPECTED ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed, expected ${EXPECTED})`);
process.exit(fail === 0 && pass + fail === EXPECTED ? 0 : 1);
