/**
 * #1972: host-owned managed-agent ENROLLMENT and terminal-release PREPARATION, driven against a
 * REAL broker and the REAL authority plane.
 *
 * Both operations let a signerless remote participant reach the host's writers, so the whole value
 * is in the refusals. Every cell below is driven through `openAuthAuthorityPlane`, which means the
 * manager gate is read over a real JetStream KV on the plane's own connection and the registration
 * proof is checked against the real data-account signing seed — not a stub the test wrote itself.
 *
 *   A. the closed parsers: unknown fields, a plaintext token where a digest belongs, an absent
 *      digest, an out-of-grammar channel, an unbounded list, and a second opId for one lifecycle.
 *   B. enrollment authorization, one cell per guard: a foreign space, a row without `supervise`,
 *      an absent gate, a frozen gate, a foreign gate principal, a stale serve epoch, and a forged
 *      proof. Each has the POSITIVE CONTROL beside it (the same call with that one fact corrected).
 *   C. prepare-retirement authorization: the same gate/proof/scope family plus the two guards only
 *      it has — a target owner that is not the authenticated owner, and an opId that is not
 *      `managedRetirementOpId(target.lifecycleUid)`.
 *   D. the dispatch refusal: stock `dispatchManagerAuthorityRequest` answers `unimplemented` for
 *      both kinds rather than falling through to a manager-lifecycle phase, and the refusal happens
 *      for a caller whose ledger row is otherwise fully granted.
 *
 * The HTTP door's own guards, its internal scope derivation, and its public-face 404 run against
 * the real daemon in remote-exchange.smoke.ts.
 *
 * Run: pnpm smoke:managed-agent-enrollment:auth   (needs nats-server on PATH)
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
  EpEnvelopeError, isReachable, managedRetirementOpId, mintLifecycleUid, newIdentity,
  parseRemoteManagedAgentEnrollmentRequest, parseRemoteManagedAgentPrepareRetirementRequest,
  remoteManagerActors, serverConfig,
  type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentPrepareRetirementRequest,
} from "@cotal-ai/core";
import { userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { cotalAuthProvider, deriveOwnerToken, ensurePinnedIdp, grantActor, newActorToken, openAuthAuthorityPlane, remoteManagerCurrentRegistrationProof } from "../src/index.js";
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
/** Capture an outcome so a cell can name the code AND the message, not just "it threw". */
const outcome = async <T>(fn: () => Promise<T>): Promise<{ value?: T; code?: string; message?: string }> => {
  try { return { value: await fn() }; } catch (e) {
    return { code: e instanceof EpEnvelopeError ? e.code : "thrown", message: e instanceof Error ? e.message : String(e) };
  }
};
const refuses = async (name: string, fn: () => Promise<unknown>, code: string, pattern: RegExp) => {
  const r = await outcome(fn);
  check(name, r.code === code && pattern.test(r.message ?? ""), r);
};
const throws = (name: string, fn: () => unknown, pattern: RegExp) => {
  try { fn(); check(name, false, "expected a refusal"); }
  catch (e) { check(name, e instanceof Error && pattern.test(e.message), e instanceof Error ? e.message : e); }
};

const space = `menr-${randomUUID().slice(0, 8)}`;
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

// One manager registration, at the real gate. EPOCH and REVISION are what the gate row carries, so
// the proof the participant must present is a function of what the broker actually holds.
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
/** A second registration whose gate is FROZEN: a takeover in flight is not a registration a
 *  participant may enroll against, and this is the instance that proves it. */
const FROZEN_INSTANCE = mintLifecycleUid();
/** A third whose gate principal belongs to another owner's serve actor. */
const FOREIGN_INSTANCE = mintLifecycleUid();
/** A fourth with no gate at all. */
const ABSENT_INSTANCE = mintLifecycleUid();

const TARGET_UID = mintLifecycleUid();
const proofFor = (instanceId: string, actor = "cli", revision = REVISION, epoch = EPOCH, owner = OWNER) =>
  remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, owner, {
    space, actor, instanceId, managerLifecycleUid: MANAGER_UID, identities,
  }, { registrationRevision: revision, processEpoch: epoch });

const enrollment = (overrides: Partial<RemoteManagedAgentEnrollmentRequest> = {}): RemoteManagedAgentEnrollmentRequest => ({
  v: 1,
  kind: "manager-managed-agent-enrollment",
  space,
  actor: "cli",
  instanceId: INSTANCE,
  managerLifecycleUid: MANAGER_UID,
  requestId: `enroll${mintLifecycleUid()}`,
  registrationProof: proofFor(INSTANCE),
  serveEpoch: EPOCH,
  target: {
    actor: "worker",
    tokenHash: newActorToken().tokenHash,
    role: "worker",
    label: "smoke worker",
    capabilities: ["run"],
    subscribe: ["general"],
    allowSubscribe: ["general"],
    allowPublish: ["general"],
  },
  identities,
  ...overrides,
});

const prepare = (overrides: Partial<RemoteManagedAgentPrepareRetirementRequest> = {}): RemoteManagedAgentPrepareRetirementRequest => ({
  v: 1,
  kind: "manager-managed-agent-prepare-retirement",
  space,
  actor: "cli",
  instanceId: INSTANCE,
  managerLifecycleUid: MANAGER_UID,
  requestId: `prepare${mintLifecycleUid()}`,
  registrationProof: proofFor(INSTANCE),
  serveEpoch: EPOCH,
  target: { owner: OWNER, actor: "worker", lifecycleUid: TARGET_UID },
  opId: managedRetirementOpId(TARGET_UID),
  identities,
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
  const enroll = (request: RemoteManagedAgentEnrollmentRequest, scope = ["supervise"]) =>
    plane!.verifyManagedAgentEnrollment({ owner: OWNER, scope, request });
  const release = (request: RemoteManagedAgentPrepareRetirementRequest, scope = ["supervise"], owner = OWNER) =>
    plane!.verifyManagedAgentPrepareRetirement({ owner, scope, request });

  console.log("A. the closed parsers");
  {
    throws("enrollment refuses an unknown top-level field",
      () => parseRemoteManagedAgentEnrollmentRequest({ ...enrollment(), lifecycleUid: mintLifecycleUid() }), /unknown field/);
    throws("enrollment refuses an unknown target field",
      () => parseRemoteManagedAgentEnrollmentRequest({ ...enrollment(), target: { ...enrollment().target, actorToken: "plaintext-secret" } }), /target carries unknown field/);
    throws("enrollment refuses a target with no token digest",
      () => parseRemoteManagedAgentEnrollmentRequest({ ...enrollment(), target: { actor: "worker" } }), /tokenHash must be a lowercase hex sha256/);
    throws("enrollment refuses a non-digest tokenHash (a plaintext token never passes as one)",
      () => parseRemoteManagedAgentEnrollmentRequest({ ...enrollment(), target: { actor: "worker", tokenHash: newActorToken().actorToken } }), /tokenHash must be a lowercase hex sha256/);
    throws("enrollment refuses an out-of-grammar channel pattern",
      () => parseRemoteManagedAgentEnrollmentRequest({ ...enrollment(), target: { ...enrollment().target, allowSubscribe: ["general..bad"] } }), /empty segment/);
    throws("enrollment bounds each ACL list",
      () => parseRemoteManagedAgentEnrollmentRequest({ ...enrollment(), target: { ...enrollment().target, allowPublish: Array.from({ length: 65 }, (_, i) => `c${i}`) } }), /65 entries, more than the 64-entry bound/);
    throws("enrollment refuses a request whose kind is the other operation",
      () => parseRemoteManagedAgentEnrollmentRequest({ ...enrollment(), kind: "manager-managed-agent-prepare-retirement" }), /must carry \{ v: 1, kind/);
    throws("prepare-retirement refuses an unknown field",
      () => parseRemoteManagedAgentPrepareRetirementRequest({ ...prepare(), extra: true }), /unknown field/);
    throws("prepare-retirement refuses a partial target",
      () => parseRemoteManagedAgentPrepareRetirementRequest({ ...prepare(), target: { owner: OWNER, actor: "worker" } }), /target must be exactly/);
    throws("prepare-retirement refuses a second valid opId for one lifecycle",
      () => parseRemoteManagedAgentPrepareRetirementRequest({ ...prepare(), opId: managedRetirementOpId(mintLifecycleUid()) }), /derived terminal operation id/);
    const parsed = parseRemoteManagedAgentEnrollmentRequest(enrollment());
    check("POSITIVE CONTROL: a well-formed enrollment parses and retains only closed fields",
      parsed.kind === "manager-managed-agent-enrollment" &&
      Object.keys(parsed).sort().join(",") === ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "target", "identities"].sort().join(","),
      Object.keys(parsed).sort());
    const parsedPrepare = parseRemoteManagedAgentPrepareRetirementRequest(prepare());
    check("POSITIVE CONTROL: a well-formed prepare-retirement parses with its derived opId intact",
      parsedPrepare.opId === managedRetirementOpId(TARGET_UID) && parsedPrepare.target.lifecycleUid === TARGET_UID, parsedPrepare);
  }

  console.log("B. enrollment authorization, against the real gate and the real proof secret");
  {
    const ok = await outcome(() => enroll(enrollment()));
    check("POSITIVE CONTROL: a current registration with supervise authorizes the enrollment",
      ok.value?.target.actor === "worker" && ok.value.instanceId === INSTANCE, ok);

    await refuses("enrollment: a request naming another host space is refused",
      () => enroll(enrollment({ space: "other" })), "permission-denied", /not host space/);
    await refuses('a row without "supervise" is refused even holding spawn and admin',
      () => enroll(enrollment(), ["spawn", "admin"]), "permission-denied", /scope "supervise"/);
    await refuses("enrollment: an instance with no gate at all is refused",
      () => enroll(enrollment({ instanceId: ABSENT_INSTANCE, registrationProof: proofFor(ABSENT_INSTANCE) })), "failed-precondition", /no current open manager gate/);
    await refuses("enrollment: a FROZEN gate is refused (a takeover in flight is not a registration)",
      () => enroll(enrollment({ instanceId: FROZEN_INSTANCE, registrationProof: proofFor(FROZEN_INSTANCE) })), "failed-precondition", /no current open manager gate/);
    await refuses("enrollment: a gate held by another owner's serve principal is refused",
      () => enroll(enrollment({ instanceId: FOREIGN_INSTANCE, registrationProof: proofFor(FOREIGN_INSTANCE) })), "permission-denied", /not serve principal/);
    await refuses("enrollment: a stale serve epoch is refused as a conflict",
      () => enroll(enrollment({ serveEpoch: EPOCH - 1, registrationProof: proofFor(INSTANCE, "cli", REVISION, EPOCH - 1) })), "conflict", new RegExp(`epoch ${EPOCH - 1} is stale; current is ${EPOCH}`));
    await refuses("enrollment: a forged registration proof is refused",
      () => enroll(enrollment({ registrationProof: `sha256:${"f".repeat(64)}` })), "permission-denied", /does not match current host registration/);
    // The proof is HOST-issued for a specific registration revision. A participant that recomputed
    // it from lifecycle coordinates alone (which it can see) would have a client-computable proof.
    await refuses("enrollment: a proof computed for a superseded registration revision is refused",
      () => enroll(enrollment({ registrationProof: proofFor(INSTANCE, "cli", REVISION - 1) })), "permission-denied", /does not match current host registration/);
    await refuses("enrollment: a proof computed under another owner is refused",
      () => enroll(enrollment({ registrationProof: proofFor(INSTANCE, "cli", REVISION, EPOCH, OTHER_OWNER) })), "permission-denied", /does not match current host registration/);
  }

  console.log("C. prepare-retirement authorization");
  {
    const ok = await outcome(() => release(prepare()));
    check("POSITIVE CONTROL: a current registration with supervise authorizes the release preparation",
      ok.value?.target.lifecycleUid === TARGET_UID && ok.value.opId === managedRetirementOpId(TARGET_UID), ok);

    await refuses("release: a target owner that is not the authenticated owner is refused",
      () => release(prepare({ target: { owner: OTHER_OWNER, actor: "worker", lifecycleUid: TARGET_UID } })), "permission-denied", /does not match authenticated owner/);
    // The opId is DERIVED, so a well-formed opId for a DIFFERENT lifecycle is the real attack: it
    // would open a second barrier over one head. The parser catches it, and so does the helper.
    await refuses("release: an opId derived for another lifecycle is refused",
      () => release(prepare({ opId: managedRetirementOpId(mintLifecycleUid()) })), "bad-request", /derived terminal operation id/);
    await refuses('prepare-retirement without "supervise" is refused',
      () => release(prepare(), ["spawn", "admin"]), "permission-denied", /scope "supervise"/);
    await refuses("release: a request naming another host space is refused",
      () => release(prepare({ space: "other" })), "permission-denied", /not host space/);
    await refuses("release: an absent gate is refused",
      () => release(prepare({ instanceId: ABSENT_INSTANCE, registrationProof: proofFor(ABSENT_INSTANCE) })), "failed-precondition", /no current open manager gate/);
    await refuses("release: a FROZEN gate is refused",
      () => release(prepare({ instanceId: FROZEN_INSTANCE, registrationProof: proofFor(FROZEN_INSTANCE) })), "failed-precondition", /no current open manager gate/);
    await refuses("release: a foreign gate principal is refused",
      () => release(prepare({ instanceId: FOREIGN_INSTANCE, registrationProof: proofFor(FOREIGN_INSTANCE) })), "permission-denied", /not serve principal/);
    await refuses("release: a stale serve epoch is refused as a conflict",
      () => release(prepare({ serveEpoch: EPOCH + 1, registrationProof: proofFor(INSTANCE, "cli", REVISION, EPOCH + 1) })), "conflict", new RegExp(`epoch ${EPOCH + 1} is stale; current is ${EPOCH}`));
    await refuses("release: a forged registration proof is refused",
      () => release(prepare({ registrationProof: `sha256:${"f".repeat(64)}` })), "permission-denied", /does not match current host registration/);
  }

  console.log("D. the stock dispatch refusal");
  {
    const store = workspaceSecretStore(tmp);
    ensurePinnedIdp(dir, "http://127.0.0.1:49151/api/auth");
    await cotalAuthProvider.prepareServer({
      store, dir, space, operatorSeed: auth.operator.seed,
      account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    });
    // A FULLY granted caller: the refusal below must be about the operation having no stock
    // composition, never about this row lacking authority.
    grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "supervise", "admin"], allowSubscribe: [">"], allowPublish: [">"] });
    const wrongArm = async () => { throw new Error("wrong dispatcher arm"); };
    const ctx = {
      space, dir, secrets: store,
      managerServiceAuthority: wrongArm as never,
      maintainRemoteManager: wrongArm as never,
      validateRetainedAgent: wrongArm as never,
      scanManagerGoalIndex: wrongArm as never,
      authorizeManagerAdmin: wrongArm as never,
    };
    await refuses("dispatch refuses an enrollment request with unimplemented",
      () => dispatchManagerAuthorityRequest(ctx, OWNER, { request: enrollment() }),
      "unimplemented", /must be handled by host platform interception/);
    await refuses("dispatch refuses a prepare-retirement request with unimplemented",
      () => dispatchManagerAuthorityRequest(ctx, OWNER, { request: prepare() }),
      "unimplemented", /must be handled by host platform interception/);
    // The proof that the refusal is the KIND branch and not a broken dispatcher: the same context,
    // the same granted row, a manager-lifecycle request — and the request reaches its arm.
    const reached = await outcome(() => dispatchManagerAuthorityRequest(ctx, OWNER, { request: {
      v: 1, kind: "manager-service-authority", operation: "prepare", space, actor: "cli",
      instanceId: INSTANCE, managerLifecycleUid: MANAGER_UID, requestId: `req${mintLifecycleUid()}`, identities,
    } }));
    check("NEGATIVE CONTROL: an ordinary manager-authority request still reaches its dispatcher arm",
      reached.message === "wrong dispatcher arm", reached);
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
const EXPECTED = 35;
console.log(`\nMANAGED-AGENT-ENROLLMENT SMOKE ${fail === 0 && pass + fail === EXPECTED ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed, expected ${EXPECTED})`);
process.exit(fail === 0 && pass + fail === EXPECTED ? 0 : 1);
