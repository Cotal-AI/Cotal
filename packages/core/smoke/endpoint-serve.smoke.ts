/**
 * v0.4 service-registry + serve/describe smoke (SPEC §13.2/§13.5/§13.7/§13.9) against a real
 * broker: registration CAS + registrationRevision semantics with authenticated-registrant
 * binding, the three-part status-write fence (spec coherence, fresh mapping equality, stored
 * conflict), the hardened scatter freeze, cluster-artifact digest verification (the §13.7
 * "readers verify fetched bytes" MUST — a same-digest invented command is unrepresentable),
 * the registry-authorized serve ARTIFACT (branded, deep-frozen, space/owner-bound, verified
 * surface + derived descriptor) consumed by construction, provenance-branded compiled
 * contracts (a forged validator/digest pair refuses), queue-grouped class serving vs scatter
 * vs instance rails, digest-bound invoke with the symmetric budgeted runtime validation,
 * registered targeted/untargeted admission (default-deny BOTH ways) plus the child/ledger
 * fresh-authorization seams, post-seam target currency (a mapping rotated during the
 * authority read fails), explicit-null canonical-void args, cast silence, awaited stop, and
 * the authorization-scoped describe over the DERIVED descriptor.
 *
 * Run: pnpm smoke:ep-serve   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, EpEnvelopeError, registryReadFailed, unansweredRequest,
  openRecordsBucket,
  parseServiceSpec, parseServiceStatus, assertServiceNameAuthority,
  registerServiceInstance, writeServiceStatus, freezeExpectedSet,
  registrationReconciler, serviceEpochReader,
  epCallService, epScatterService, epScatter,
  authorizeServeGrant, assertServeGrantAuthorized,
  SERVICE_READY, SERVICE_EXITED,
  serveEndpoint,
  compileContract, contractDigest, VOID_SCHEMA,
  parseClusterDocument, verifyClusterManifest, verifyClusterRoot,
  epRequestSubject, epCallerReplyFilter, parseEpSubject, recordSpecKey, recordStatusKey, RECORD_KINDS,
  type ServiceSpec, type ServiceNameAuthority, type EpCaller, type EndpointReply,
  type EpCommandDef, type DescribeAnswer, type EpServeGrant, type CompiledContract,
  type EpIssuanceBarrier, type EpVerbOp,
} from "../src/index.js";
import type { KV } from "@nats-io/kv";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

/** READING THIS SUITE'S OUTPUT — the reporting is INVERTED and the inversion is a trap.
 *
 *  `c()` prints NOTHING on a pass. A cell's name appears in the output **if and only if it FAILED**.
 *  So an empty grep for a cell name is the SUCCESS signal here, which is backwards from every other
 *  instrument: normally an empty result means the pattern missed or the thing is absent. Someone
 *  auditing a run by grepping for a cell name — without reading this line — misreads every run they
 *  do, and half the misreadings are the reassuring direction.
 *
 *  So: to check ONE cell, grep its name and expect NOTHING when it passes. Never read the suite's
 *  exit code as evidence about a single cell — any other cell failing gives you a red total while
 *  the cell you care about quietly still passes, and still-passing is exactly what a vacuous cell
 *  does. The aggregate cannot show you one vacuous cell; only that cell's absence-or-presence can. */
let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown, code?: string) => {
  try { fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const rejects = async (n: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epserve";
const IID_A = "a".repeat(26);
const IID_B = "b".repeat(26);
const UID = "c".repeat(26);
const T_UID = "d".repeat(26);
const OTHER_UID = "e".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

// Real §13.7 contracts: the closure digests ARE the pinned op digests.
const argsContract = compileContract({ root: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } });
const outContract = compileContract({ root: { type: "object", properties: { which: { type: "string" } }, required: ["which"], additionalProperties: false } });
const voidContract = compileContract({ root: VOID_SCHEMA });
// A REAL compiled output contract that is legitimately slow on a large payload: 8 pattern
// properties x 400k items decisively exceeds the fixed 10ms §13.8 budget (measured 112-150ms),
// so the over-budget path is proven WITHOUT forging a compiled contract (forgery refuses).
// It is also ~125MB serialized, well over any broker's max_payload. That was incidental while the
// budget still REFUSED an over-budget output before encoding it; now that the budget only reports,
// this payload reaches the publish, and the pair of properties is what makes it a real test of
// what a responder does with a valid reply it cannot send.
const slowProps: Record<string, unknown> = {};
for (let i = 0; i < 8; i++) slowProps[`f${i}`] = { type: "string", pattern: "^[a-z][a-z0-9-]{1,128}$" };
const slowContract = compileContract({ root: { type: "array", items: { type: "object", required: Object.keys(slowProps), additionalProperties: false, properties: slowProps } } });
const slowItem = Object.fromEntries(Object.keys(slowProps).map((k) => [k, "abcdefghij-0123456789-abcdefghij"]));
const slowPayload = Array.from({ length: 400_000 }, () => slowItem);
const D_IN = argsContract.closureDigest;
const D_OUT = outContract.closureDigest;
const D_VOID = voidContract.closureDigest;
const D_SLOW = slowContract.closureDigest;
const D_OTHER = `sha256:${"f".repeat(64)}`;

// The provenance-branded compiled contracts each command's def must carry, matching its
// registered declaration's digests exactly (ping is void-input, slow is slow-output).
const contractFor = (command: string): { input: CompiledContract; output: CompiledContract } =>
  command === "ping" ? { input: voidContract, output: outContract }
    : command === "slow" ? { input: argsContract, output: slowContract }
      : { input: argsContract, output: outContract };

// §13.7 cluster documents: the content-addressed authority for every command's served shape.
const cmd = (name: string, over: Record<string, unknown> = {}) => ({
  name, class: "ephemeral", targeted: false, capability: "manager.call",
  inputDigest: D_IN, outputDigest: D_OUT, ...over,
});
const DOC_MAIN = {
  urn: "ai.cotal.manager", revision: 1, attributes: [], events: [],
  commands: [
    cmd("status"),
    cmd("inspect", { targeted: true, modes: ["owner"] }),
    cmd("badout"),
    cmd("cyclic"),
    cmd("poke"),
    cmd("slow", { outputDigest: D_SLOW }),
    cmd("ping", { inputDigest: D_VOID }),
  ],
};
const DOC_AUX = { urn: "ai.cotal.aux", revision: 1, attributes: [], events: [], commands: [cmd("extra")] };
const DOC_INSPECT = { urn: "ai.cotal.inspect", revision: 1, attributes: [], events: [], commands: [cmd("inspect", { targeted: true, modes: ["owner"] })] };
const DOC_REL = {
  urn: "ai.cotal.relations", revision: 1, attributes: [], events: [],
  commands: [
    cmd("adopt", { targeted: true, modes: ["child"] }),
    cmd("audit", { targeted: true, modes: ["ledger"] }),
  ],
};
// A JOURNAL-class command declares its admission ceiling whether or not it carries the action
// marker — the marker sits on top of the class, and it is the CLASS that makes a command receive
// submissions. This fixture predates that rule and went red when it landed, which is the rule
// working: `submitjob` is a real journal-class non-action command, and it had no ceiling.
const DOC_JOURNAL = { urn: "ai.cotal.jobs", revision: 1, attributes: [], events: [], commands: [cmd("submitjob", { class: "journal", admissionCeiling: { maxBytes: 65536, maxDepth: 16, maxItems: 256 } })] };
// A MIXED endpoint: one ephemeral (rail-served) command + one journal command. Both belong to
// the credential/descriptor surface; only "run" gets a rail def (SPEC 13.4/13.7).
const DOC_MIXED = { urn: "ai.cotal.mixed", revision: 1, attributes: [], events: [], commands: [cmd("run"), cmd("submitjob", { class: "journal", admissionCeiling: { maxBytes: 65536, maxDepth: 16, maxItems: 256 } })] };
// §13.7 two-digest content addressing: the registered CLOSURE digest names a MANIFEST
// `{v:1, root:<artifactDigest>, members:[]}`; the manifest's root names the cluster DOCUMENT.
// The store (D8 provides the production epc reader) holds BOTH artifacts, each at its own digest.
const store = new Map<string, unknown>();
const register = (doc: unknown): string => {
  const rootDigest = contractDigest(doc);
  const manifest = { v: 1, root: rootDigest, members: [] as string[] };
  const closureDigest = contractDigest(manifest);
  store.set(rootDigest, doc);
  store.set(closureDigest, manifest);
  return closureDigest;
};
const DC_MAIN = register(DOC_MAIN);
const DC_AUX = register(DOC_AUX);
const DC_INSPECT = register(DOC_INSPECT);
const DC_REL = register(DOC_REL);
const DC_JOURNAL = register(DOC_JOURNAL);
const DC_MIXED = register(DOC_MIXED);
const readClusterArtifact = (d: string) => store.get(d);

const authority: ServiceNameAuthority = {
  // ONE atomic snapshot: a core name needs operator authority (u_op); a reverse-DNS name binds to
  // its registered owner (com.acme.builds -> u_acme); an unregistered name is never authorized.
  authorize: (name, owner) => ({
    authorized: name.includes(".") ? (name === "com.acme.builds" && owner === "u_acme") : owner === "u_op",
    revision: 0,
  }),
};

// Per-instance §13.1 issuance-gate barriers so every registration serializes on a per-(endpoint,
// instanceId) gate. This smoke exercises the registry/serve/describe SURFACE; the fence internals
// (revision-pinned CAS, freeze token, verified evict, drift) are proven in endpoint-serve-auth.smoke.ts.
// Here the barrier only needs to be a faithful freeze->(spec write)->reopen writer.
const gateStates = new Map<string, { space: string; endpoint: string; lifecycleUid: string; principal: string; state: "open" | "frozen" | "retired"; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number; revision: number }>();
function barrierFor(endpoint: string, instanceId: string): EpIssuanceBarrier {
  const key = `${endpoint}/${instanceId}`;
  if (!gateStates.has(key)) gateStates.set(key, { space: SPACE, endpoint, lifecycleUid: instanceId, principal: "u_op.mgr", state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 });
  const g = gateStates.get(key)!;
  return {
    observe: () => ({ ...g }),
    freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
    enumerate: () => [],
    revoke: () => {},
    evict: () => true,
    reopen: (token, succ) => { if (g.state !== "frozen" || g.revision !== token) return false; g.state = "open"; g.generation = succ.generation; g.processEpoch = succ.processEpoch; g.registrationRevision = succ.registrationRevision; g.nameAuthorityRevision = succ.nameAuthorityRevision; g.revision++; return true; },
  };
}
/** register-with-barrier: thread the per-instance barrier so the registration runs its §13.1 protocol. */
const reg = (kvArg: KV, args: { spec: ServiceSpec; instanceId: string; registrant: { owner: string }; authority: ServiceNameAuthority }) =>
  registerServiceInstance(kvArg, { ...args, space: SPACE, barrier: barrierFor(args.spec.endpoint, args.instanceId), readClusterArtifact });

// ── name authority (broker-free; the authority read is async) ──
c("a core name under the operator owner admits",
  (await assertServiceNameAuthority("manager", "u_op", authority)) === 0);
await rejects("a core name under a non-operator owner refuses",
  () => assertServiceNameAuthority("manager", "u_abc", authority), "permission-denied");
c("a reverse-DNS name under its registered owner admits",
  (await assertServiceNameAuthority("com.acme.builds", "u_acme", authority)) === 0);
await rejects("a reverse-DNS name under a foreign owner refuses",
  () => assertServiceNameAuthority("com.acme.builds", "u_abc", authority), "permission-denied");
await rejects("an UNREGISTERED reverse-DNS name fails closed (never first-come adoption)",
  () => assertServiceNameAuthority("com.evil.squat", "u_abc", authority), "permission-denied");

// ── record-value validators (broker-free) ──
const spec: ServiceSpec = {
  endpoint: "manager", owner: "u_op", clusterDigests: [DC_MAIN, DC_AUX], protocol: { v: 1 },
};
c("a service spec validates", parseServiceSpec(spec, { endpoint: "manager" }).owner === "u_op");
throws("a spec whose endpoint disagrees with the record key refuses",
  () => parseServiceSpec(spec, { endpoint: "other" }), "internal");
throws("a spec with empty clusterDigests refuses",
  () => parseServiceSpec({ ...spec, clusterDigests: [] }, { endpoint: "manager" }), "internal");
throws("a spec with a non-1 protocol version refuses",
  () => parseServiceSpec({ ...spec, protocol: { v: 2 } }, { endpoint: "manager" }), "internal");
c("a service status validates",
  parseServiceStatus({ epoch: 3, state: SERVICE_READY, observedSpecRevision: 1 }).epoch === 3);
throws("a status with a malformed state token refuses",
  () => parseServiceStatus({ epoch: 3, state: "Ready!", observedSpecRevision: 1 }), "internal");

// ── cluster artifacts (broker-free): two-digest content addressing + the document contract ──
const MANIFEST_MAIN = store.get(DC_MAIN) as { root: string };
c("a cluster MANIFEST verifies against its closure digest and names the root artifact",
  verifyClusterManifest(DC_MAIN, MANIFEST_MAIN).root === contractDigest(DOC_MAIN));
c("the root document verifies against the manifest root and parses its command surface",
  verifyClusterRoot(MANIFEST_MAIN.root, DOC_MAIN).commands.some((m) => m.name === "inspect" && m.targeted && m.modes?.[0] === "owner"));
throws("a raw ROOT document presented at the CLOSURE digest fails manifest verification (no digest conflation)",
  () => verifyClusterManifest(DC_MAIN, DOC_MAIN));
throws("a NON-EMPTY closure manifest refuses (multi-artifact bundles are the deferred D8 loader)",
  () => verifyClusterManifest(contractDigest({ v: 1, root: contractDigest(DOC_MAIN), members: [contractDigest(DOC_AUX)] }), { v: 1, root: contractDigest(DOC_MAIN), members: [contractDigest(DOC_AUX)] }));
throws("TAMPERED root bytes do not verify against the manifest root (a reader MUST verify fetched bytes)",
  () => verifyClusterRoot(MANIFEST_MAIN.root, { ...DOC_MAIN, commands: [...DOC_MAIN.commands, cmd("stop")] }));
throws("a targeted command without declared modes refuses to parse",
  () => parseClusterDocument({ ...DOC_MAIN, commands: [cmd("x", { targeted: true })] }));
throws("an untargeted command declaring modes refuses to parse",
  () => parseClusterDocument({ ...DOC_MAIN, commands: [cmd("x", { modes: ["owner"] })] }));
throws("an unknown authorization mode refuses to parse",
  () => parseClusterDocument({ ...DOC_MAIN, commands: [cmd("x", { targeted: true, modes: ["boss"] })] }));
throws("a cluster document declaring describe refuses (reserved, never a cluster command)",
  () => parseClusterDocument({ ...DOC_MAIN, commands: [cmd("describe")] }));
throws("a duplicate command declaration refuses to parse",
  () => parseClusterDocument({ ...DOC_MAIN, commands: [cmd("x"), cmd("x")] }));

// ── unreadable vs empty registry: the enumeration boundary, RE-POINTED at STREAM.INFO ──
// The old fixture stubbed `kv.keys`, which the consumer-free enumeration no longer calls. Measured:
// with that stub removed entirely the cell still passed (disarmed run, 133/0, this cell silent) — it
// was green on an empty `{}` jsm throwing a TypeError, not on any permissions failure.
//
// And the CODE ALONE CANNOT DISCRIMINATE HERE, which is the hazard the substitution introduces: an
// unreadable registry and an EMPTY one are both `failed-precondition`. Under `kv.keys` a refusal
// threw; under STREAM.INFO a refused read and a registry with no matching subjects differ only in
// which throw fires. Collapsing them reports "no managers" as an empty success, and an empty registry
// is never an empty success (SPEC 13.5). So both arms pin their MESSAGE, and a third asserts the two
// messages actually differ — the discriminator has to be absent from one side to discriminate at all.
const freezeErr = async (jsmStub: unknown): Promise<{ code?: string; message: string }> => {
  try { await freezeExpectedSet(jsmStub as never, SPACE, "manager"); return { message: "NO THROW" }; }
  catch (e) { return { code: (e as EpEnvelopeError).code, message: (e as Error).message }; }
};
{
  const refused = await freezeErr({ streams: { info: () => { throw new Error("permissions violation"); } } });
  c("a REFUSED registry read is failed-precondition and says UNREADABLE (never an empty success)",
    refused.code === "failed-precondition" && /is unreadable/.test(refused.message), refused);
  const empty = await freezeErr({ streams: { info: () => ({ state: { subjects: {} } }) } });
  c("an EMPTY-but-readable registry is failed-precondition and says NO LIVE INSTANCES (a distinct event)",
    empty.code === "failed-precondition" && /no live registered instances/.test(empty.message), empty);
  c("refused and empty are NOT collapsed: different messages",
    refused.message !== empty.message && /is unreadable/.test(refused.message) && !/is unreadable/.test(empty.message),
    { refused: refused.message.slice(0, 70), empty: empty.message.slice(0, 70) });
}

// ── live broker ──
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

  // ---- registry over the records KV ----
  const kv = await openRecordsBucket(nc, SPACE, { create: true });
  const jsm = await jetstreamManager(nc);
  const asOp = { owner: "u_op" };

  const regA = await reg(kv, { spec, instanceId: IID_A, registrant: asOp, authority });
  c("registration writes the spec and returns its store revision", regA.registrationRevision >= 1);
  const regA2 = await reg(kv, { spec, instanceId: IID_A, registrant: asOp, authority });
  c("re-registration ADVANCES registrationRevision (scatter churn detection, SPEC 13.5)",
    regA2.registrationRevision > regA.registrationRevision);
  // P2 item 3 (SPEC 13.6 item 7): a re-registration of the SAME instanceId is a restarted/superseded
  // incarnation — the gate's processEpoch ADVANCES so the successor fences the predecessor's epoch
  // (the empty-family stub here is exactly the open-mesh path: nothing to evict, the advance still
  // rides the completing reopen).
  c("re-registration ADVANCES the gate processEpoch (a restarted incarnation fences the predecessor's epoch)",
    gateStates.get(`manager/${IID_A}`)!.processEpoch === 1);
  await rejects("a registration whose authenticated caller is not the descriptor owner refuses (impersonation)",
    () => reg(kv, { spec, instanceId: IID_A, registrant: { owner: "u_abc" }, authority }), "permission-denied");
  await rejects("a registration under an unauthorized claimed owner refuses",
    () => reg(kv, { spec: { ...spec, owner: "u_abc" }, instanceId: IID_A, registrant: { owner: "u_abc" }, authority }), "permission-denied");
  // Ownership stability across authority drift: the SAME name re-minted to a new owner cannot
  // take over an instanceId registered under the old one.
  const acmeSpec: ServiceSpec = { endpoint: "com.acme.builds", owner: "u_acme", clusterDigests: [DC_MAIN], protocol: { v: 1 } };
  await reg(kv, { spec: acmeSpec, instanceId: IID_A, registrant: { owner: "u_acme" }, authority });
  const driftedAuthority: ServiceNameAuthority = { authorize: (_n, owner) => ({ authorized: owner === "u_evil", revision: 0 }) };
  await rejects("a re-registration cannot change an instance's ownership (id reuse across identities)",
    () => reg(kv, { spec: { ...acmeSpec, owner: "u_evil" }, instanceId: IID_A, registrant: { owner: "u_evil" }, authority: driftedAuthority }), "permission-denied");

  // ---- the three-part status-write fence ----
  const mapping = { current: 2 };
  const readProcessEpoch = () => mapping.current;
  await rejects("a status write with NO registered spec refuses (would create torn record state)",
    () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_B, epoch: 2, readProcessEpoch, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: 1 } }), "failed-precondition");
  await rejects("a status observing a spec revision AHEAD of the store refuses",
    () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 2, readProcessEpoch, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision + 50 } }), "failed-precondition");
  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 2, readProcessEpoch, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } });
  // THE takeover window (SPEC 13.9): mapping has advanced to 3, stored status is still 2 — a
  // stale epoch-2 write passes the stored-monotonic check and MUST die on the mapping fence.
  mapping.current = 3;
  await rejects("a stored-equal epoch behind the FRESH mapping refuses `expired` (the takeover window)",
    () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 2, readProcessEpoch, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } }), "expired");
  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, readProcessEpoch, status: { epoch: 3, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } });
  mapping.current = 2; // a rogue mapping regression: below-stored is CONFLICT, distinct from the mapping fence
  await rejects("a below-stored epoch refuses `conflict` (distinct from the mapping fence)",
    () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 2, readProcessEpoch, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } }), "conflict");
  mapping.current = 3;
  await rejects("a status payload epoch disagreeing with the writer-authenticated epoch refuses",
    () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, readProcessEpoch, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } }), "internal");

  // ---- the hardened freeze ----
  const regB = await reg(kv, { spec, instanceId: IID_B, registrant: asOp, authority });
  c("a FIRST registration of a fresh instanceId keeps epoch 0 (a never-restarted single manager)",
    gateStates.get(`manager/${IID_B}`)!.processEpoch === 0);
  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_B, epoch: 1, readProcessEpoch: () => 1, status: { epoch: 1, state: SERVICE_READY, observedSpecRevision: regB.registrationRevision } });
  const frozen = await freezeExpectedSet(jsm, SPACE, "manager");
  c("the frozen expected set carries (instanceId, registrationRevision, epoch) per live instance",
    frozen.length === 2
    && frozen.some((f) => f.instanceId === IID_A && f.registrationRevision === regA2.registrationRevision && f.epoch === 3)
    && frozen.some((f) => f.instanceId === IID_B && f.registrationRevision === regB.registrationRevision && f.epoch === 1));
  // A stale projection is NOT live under the current registration: re-register B (spec revision
  // advances) while its status still observes the old revision — freezing (new rev, old epoch)
  // would combine a registration with liveness it never had.
  const regB2 = await reg(kv, { spec, instanceId: IID_B, registrant: asOp, authority });
  c("each restart advances the gate epoch monotonically (B: first 0 -> restart 1)",
    gateStates.get(`manager/${IID_B}`)!.processEpoch === 1);
  c("a stale projection (status behind the CURRENT registration) leaves the frozen set",
    regB2.registrationRevision > regB.registrationRevision
    && (await freezeExpectedSet(jsm, SPACE, "manager")).every((f) => f.instanceId !== IID_B));
  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_B, epoch: 1, readProcessEpoch: () => 1, status: { epoch: 1, state: SERVICE_EXITED, observedSpecRevision: regB2.registrationRevision } });
  c("an exited instance leaves the frozen set", (await freezeExpectedSet(jsm, SPACE, "manager")).every((f) => f.instanceId !== IID_B));
  await rejects("an empty registry is failed-precondition, never an empty scatter success",
    () => freezeExpectedSet(jsm, SPACE, "ghost"), "failed-precondition");
  // Malformed mediated-writer state fails LOUD (§13.9), never enters the set.
  await kv.put(recordSpecKey(RECORD_KINDS.svc, ["manager", T_UID]), new TextEncoder().encode(JSON.stringify({ attackerControlled: true, owner: "u_evil" })));
  await kv.put(`svc.manager.${T_UID}.status`, new TextEncoder().encode(JSON.stringify({ epoch: 1, state: SERVICE_READY, observedSpecRevision: 1 })));
  await rejects("a malformed registered spec fails LOUD at the freeze, never enters the set",
    () => freezeExpectedSet(jsm, SPACE, "manager"), "internal");
  await kv.purge(recordSpecKey(RECORD_KINDS.svc, ["manager", T_UID]));
  await kv.purge(`svc.manager.${T_UID}.status`);

  // ---- serve-artifact authorization (the §13.9 fence over VERIFIED registered bytes) ----
  // The surface is the FULL union of the registered clusters' verified commands (SPEC 13.9:
  // the credential binds its whole registered surface; no caller subset).
  const ALL_MAIN = ["badout", "cyclic", "extra", "inspect", "ping", "poke", "slow", "status"]; // sorted
  const authorizeA = (over: Record<string, unknown> = {}) => authorizeServeGrant(kv, {
    space: SPACE, endpoint: "manager", instanceId: IID_A, epoch: 3,
    holder: asOp, authority, readProcessEpoch: () => 3, readClusterArtifact, ...over,
  });
  const grantA = await authorizeA();
  c("a registered instance authorizes: the artifact binds space/owner and carries the FULL VERIFIED surface",
    grantA.space === SPACE && grantA.owner === "u_op" && grantA.epoch === 3
    && JSON.stringify([...grantA.commands]) === JSON.stringify(ALL_MAIN)
    && grantA.surface.inspect?.targeted === true && grantA.surface.inspect.modes[0] === "owner"
    && grantA.surface.status?.targeted === false && grantA.surface.submitjob === undefined
    && (assertServeGrantAuthorized(grantA), true),
    JSON.stringify([...grantA.commands]));
  c("the DERIVED descriptor projects the FULL verified clusters with the cluster DOCUMENT inline",
    grantA.descriptor.clusters.length === 2
    && grantA.descriptor.clusters[0].digest === DC_MAIN
    // the inline copy is the root cluster document (its urn + command declarations), NOT the
    // manifest — and it verifies against the advertised closure digest via the single-member
    // manifest reconstruction.
    && (grantA.descriptor.clusters[0].document as { urn?: string })?.urn === "ai.cotal.manager"
    && contractDigest({ v: 1, root: contractDigest(grantA.descriptor.clusters[0].document), members: [] }) === DC_MAIN
    && grantA.descriptor.clusters[1].digest === DC_AUX
    && JSON.stringify(grantA.descriptor.clusters[1].commands) === JSON.stringify(["extra"]),
    JSON.stringify(grantA.descriptor.clusters[0].document));
  // Two-stage store tampers. A manifest whose bytes are corrupted at the closure-digest key
  // (a non-empty members list here) does not hash to that digest → manifest verification fails.
  const savedMainManifest = store.get(DC_MAIN);
  const rootMain = contractDigest(DOC_MAIN);
  store.set(DC_MAIN, { v: 1, root: rootMain, members: [contractDigest(DOC_AUX)] });
  await rejects("a corrupted manifest at the closure-digest key fails verification LOUD",
    () => authorizeA(), "internal");
  store.set(DC_MAIN, savedMainManifest);
  // Tampered ROOT bytes (same root-digest key, invented 'stop'): second-stage verification fails.
  store.set(rootMain, { ...DOC_MAIN, commands: [...DOC_MAIN.commands, cmd("stop")] });
  await rejects("TAMPERED root bytes (same digest key, invented 'stop') fail verification LOUD, never authorize",
    () => authorizeA(), "internal");
  store.set(rootMain, DOC_MAIN);
  // A registered instance whose manifest VERIFIES but whose root artifact is absent AT SERVE
  // AUTHORIZATION: fail closed. Registration reads the clusters for its §13.7 governance check, so
  // the root must be present to register (the ghost command is un-governed, so nothing is recorded)
  // — then the root is removed to model a store that lost it before the serve grant is authorized.
  const orphanDoc = { urn: "ai.cotal.orphan", revision: 1, attributes: [], events: [], commands: [cmd("ghost")] };
  const orphanRoot = contractDigest(orphanDoc);
  const orphanManifest = { v: 1, root: orphanRoot, members: [] as string[] };
  const orphanClosure = contractDigest(orphanManifest);
  store.set(orphanClosure, orphanManifest);
  store.set(orphanRoot, orphanDoc); // readable at registration
  await reg(kv, { spec: { endpoint: "mgrorphan", owner: "u_op", clusterDigests: [orphanClosure], protocol: { v: 1 } }, instanceId: IID_A, registrant: asOp, authority });
  store.delete(orphanRoot); // the store loses the root before the serve grant is authorized
  await rejects("a manifest whose ROOT artifact is unreadable refuses (fail closed)",
    () => authorizeServeGrant(kv, { space: SPACE, endpoint: "mgrorphan", instanceId: IID_A, epoch: 1, holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact }), "failed-precondition");
  // An unreadable MANIFEST at the registered closure digest: fail closed.
  store.delete(DC_AUX);
  await rejects("an UNREADABLE registered cluster manifest refuses (fail closed, never a weaker source)",
    () => authorizeA(), "failed-precondition");
  store.set(DC_AUX, { v: 1, root: contractDigest(DOC_AUX), members: [] });
  await rejects("a FAILING contract-store seam is unavailable (fail closed)",
    () => authorizeA({ readClusterArtifact: () => { throw new Error("store down"); } }), "unavailable");
  await rejects("an UNREGISTERED instance cannot authorize (foreign instance)",
    () => authorizeA({ instanceId: "f".repeat(26) }), "failed-precondition");
  await rejects("a holder that is not the registered owner cannot authorize (foreign name)",
    () => authorizeA({ holder: { owner: "u_abc" } }), "permission-denied");
  await rejects("name-authority DRIFT refuses fresh (the old registration cannot keep minting)",
    () => authorizeA({ authority: { authorize: () => ({ authorized: false, revision: 0 }) } }), "permission-denied");
  await rejects("a serve grant for a NON-CURRENT epoch refuses expired (only the current incarnation mints)",
    () => authorizeA({ epoch: 2 }), "expired");
  throws("a RAW unbranded serve artifact refuses",
    () => assertServeGrantAuthorized({ ...grantA } as EpServeGrant), "permission-denied");
  throws("the authorized artifact is frozen: post-authorization mutation throws instead of widening",
    () => { (grantA as { epoch: number }).epoch = 99; });
  throws("the derived descriptor is DEEP-frozen: a cluster command list cannot be appended to",
    () => { (grantA.descriptor.clusters[0].commands as string[]).push("stop"); });
  throws("the verified surface is frozen: a declaration cannot be flipped post-authorization",
    () => { (grantA.surface.status as { targeted: boolean }).targeted = true; });

  // ---- serve-table construction: the artifact is the only door ----
  const def = (command: string, over: Partial<EpCommandDef> = {}): EpCommandDef => ({
    command, contract: contractFor(command),
    handler: () => ({ which: "x" }), ...over,
  });
  const fullDefs = (): EpCommandDef[] => ALL_MAIN.map((command) => def(command));
  throws("serve construction refuses a raw (unbranded) artifact",
    () => serveEndpoint(null as never, SPACE, { ...grantA } as EpServeGrant, [def("status")], { public: true }), "permission-denied");
  throws("serve construction refuses a foreign space (the artifact binds its space)",
    () => serveEndpoint(null as never, "otherspace", grantA, [def("status")], { public: true }));
  throws("a def for an UNGRANTED command refuses at construction",
    () => serveEndpoint(null as never, SPACE, grantA, [def("stop")], { public: true }));
  throws("a FORGED compiled contract (arbitrary validator wearing a registered digest) refuses at construction",
    () => serveEndpoint(null as never, SPACE, grantA,
      [def("status", { contract: { input: { validate: () => true, closureDigest: D_IN } as unknown as CompiledContract, output: outContract } })],
      { public: true }));
  throws("a compiled contract whose digest is not the REGISTERED declaration refuses at construction",
    () => serveEndpoint(null as never, SPACE, grantA, [def("status", { contract: { input: outContract, output: outContract } })], { public: true }));
  throws("a custom describe def refuses at construction (the authorization seam is not replaceable)",
    () => serveEndpoint(null as never, SPACE, grantA, [def("describe")], { public: true }));
  throws("a granted command with NO def refuses at construction (no rail nobody serves)",
    () => serveEndpoint(null as never, SPACE, grantA, [def("status")], { public: true }));
  throws("an EXTRA def outside the granted surface refuses at construction",
    () => serveEndpoint(null as never, SPACE, grantA, [...fullDefs(), def("phantom")], { public: true }));
  // A journal-class registered command refuses rail-serving (journal rides epj submissions).
  await reg(kv, { spec: { endpoint: "mgrjob", owner: "u_op", clusterDigests: [DC_JOURNAL], protocol: { v: 1 } }, instanceId: IID_A, registrant: asOp, authority });
  const grantJournal = await authorizeServeGrant(kv, {
    space: SPACE, endpoint: "mgrjob", instanceId: IID_A, epoch: 1,
    holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact,
  });
  throws("a JOURNAL-class registered command refuses rail-serving at construction (journal rides epj)",
    () => serveEndpoint(null as never, SPACE, grantJournal, [def("submitjob")], { public: true }));

  // ---- D14 bind-row inputs on the branded artifact (journalClass = registered truth, pools =
  // provisioning truth) ----
  c("a journal surface derives journalClass=true on the artifact (pools default to none)",
    grantJournal.journalClass === true && Array.isArray(grantJournal.pools) && grantJournal.pools.length === 0);
  c("an ephemeral surface derives journalClass=false",
    (await authorizeA()).journalClass === false);
  {
    const withPools = await authorizeServeGrant(kv, {
      space: SPACE, endpoint: "mgrjob", instanceId: IID_A, epoch: 1,
      holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact, pools: ["zeta", "alpha"],
    });
    c("provisioner-asserted pools are validated + sorted into the artifact", withPools.pools.join(",") === "alpha,zeta");
    await rejects("a DUPLICATE pool refuses (the provisioner enumerates each pre-created pool once)",
      () => authorizeServeGrant(kv, {
        space: SPACE, endpoint: "mgrjob", instanceId: IID_A, epoch: 1,
        holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact, pools: ["p1", "p1"],
      }), "internal");
    await rejects("pools on an EPHEMERAL-ONLY surface refuse (only journal acceptances route to work pools)",
      () => authorizeServeGrant(kv, {
        space: SPACE, endpoint: "manager", instanceId: IID_A, epoch: 1,
        holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact, pools: ["p1"],
      }), "failed-precondition");
    await rejects("a malformed pool token never becomes an artifact field",
      () => authorizeServeGrant(kv, {
        space: SPACE, endpoint: "mgrjob", instanceId: IID_A, epoch: 1,
        holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact, pools: ["BAD POOL"],
      }));
  }

  // §13.6 virtual registration: an ON-DEMAND activation policy is only valid over an
  // all-journal-class surface (an ephemeral call to an endpoint with no live instance is an
  // honest `unavailable`, so it cannot be advertised).
  {
    const vpol = { mode: "on-demand", capacity: 4 };
    await reg(kv, { spec: { endpoint: "vjob", owner: "u_op", clusterDigests: [DC_JOURNAL], protocol: { v: 1 }, activation: vpol }, instanceId: IID_A, registrant: asOp, authority });
    c("an on-demand registration over an all-journal surface is admitted", true);
    await rejects("an on-demand registration over an EPHEMERAL command refuses (a virtual endpoint's commands MUST be journal-class)",
      () => reg(kv, { spec: { endpoint: "veph", owner: "u_op", clusterDigests: [DC_MAIN], protocol: { v: 1 }, activation: vpol }, instanceId: IID_A, registrant: asOp, authority }), "failed-precondition");
    await rejects("an on-demand registration over a MIXED surface refuses (the one ephemeral command is enough)",
      () => reg(kv, { spec: { endpoint: "vmixed", owner: "u_op", clusterDigests: [DC_MIXED], protocol: { v: 1 }, activation: vpol }, instanceId: IID_A, registrant: asOp, authority }), "failed-precondition");
    // NON-JOURNAL WINS the cross-cluster class merge: a command declared ephemeral in one
    // cluster and journal in another is ephemeral for the check, so a later journal
    // redeclaration cannot mask the earlier ephemeral one and sneak a virtual registration in.
    const DOC_EPH_RUN = { urn: "ai.cotal.ephrun", revision: 1, attributes: [], events: [], commands: [cmd("run")] };
    const DOC_JRN_RUN = { urn: "ai.cotal.jrnrun", revision: 1, attributes: [], events: [], commands: [cmd("run", { class: "journal", admissionCeiling: { maxBytes: 65536, maxDepth: 16, maxItems: 256 } })] };
    const DC_EPH_RUN = register(DOC_EPH_RUN);
    const DC_JRN_RUN = register(DOC_JRN_RUN);
    // A command name declared in TWO clusters is an ambiguous surface: registration refuses the
    // duplicate up front (regardless of class or order), rather than publishing a surface that
    // serve authorization would later reject as internal-ambiguous.
    await rejects("registration with a cross-cluster DUPLICATE command name REFUSES (ambiguous surface)",
      () => reg(kv, { spec: { endpoint: "vmerge", owner: "u_op", clusterDigests: [DC_EPH_RUN, DC_JRN_RUN], protocol: { v: 1 }, activation: vpol }, instanceId: IID_A, registrant: asOp, authority }), "failed-precondition");
    // …and a NON-virtual registration with a cross-cluster duplicate is refused too (not activation-gated).
    await rejects("a non-virtual registration with a cross-cluster duplicate name also REFUSES",
      () => reg(kv, { spec: { endpoint: "vmerge2", owner: "u_op", clusterDigests: [DC_EPH_RUN, DC_JRN_RUN], protocol: { v: 1 } }, instanceId: IID_A, registrant: asOp, authority }), "failed-precondition");
  }

  // ---- serve: two instances of one class ----
  const grantB = await authorizeServeGrant(kv, {
    space: SPACE, endpoint: "manager", instanceId: IID_B, epoch: 1,
    holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact,
  });
  let castRuns = 0;
  let gateArmed = false;
  let gate: (() => void) | undefined;
  const targets = new Map<string, { lifecycleUid: string; mappingRevision: number }>([
    [`u_abc.svc`, { lifecycleUid: T_UID, mappingRevision: 7 }],
  ]);
  const resolveTarget = (t: { owner: string; actor: string }) => targets.get(`${t.owner}.${t.actor}`);
  const commandsFor = (which: string): EpCommandDef[] => [
    def("status", { handler: async () => {
      if (!gateArmed) return { which };
      gateArmed = false;
      await new Promise<void>((r) => { gate = r; }); // park until the smoke releases the gate
      return { which };
    } }),
    def("inspect", { handler: () => ({ which }) }),
    def("badout", { handler: () => ({ wrong: true }) }),
    def("cyclic", { handler: () => { const o: Record<string, unknown> = { which }; o.self = o; return o; } }),
    def("poke", { handler: () => { castRuns++; throw new Error("cast handlers may fail; nobody hears it"); } }),
    def("slow", { contract: { input: argsContract, output: slowContract }, handler: () => slowPayload }),
    def("ping", { contract: { input: voidContract, output: outContract }, handler: () => ({ which }) }),
    def("extra", { handler: () => ({ which }) }),
  ];
  let viewCalls = 0;
  const scoped = { view: (who: EpCaller) => { viewCalls++; return who.owner === "u_abc" ? { commands: ["status", "badout", "cyclic", "extra"] } : undefined; } };
  const srvA = serveEndpoint(nc, SPACE, grantA, commandsFor("A"), scoped, { resolveTarget });
  const srvB = serveEndpoint(nc, SPACE, grantB, commandsFor("B"), scoped, { resolveTarget });
  await nc.flush();

  // The caller's reply rail: exactly its own filter (§13.9).
  const replies: { subject: string; reply: EndpointReply }[] = [];
  const replySub = nc.subscribe(epCallerReplyFilter(SPACE, caller), {
    callback: (_e, m) => { replies.push({ subject: m.subject, reply: JSON.parse(new TextDecoder().decode(m.data)) as EndpointReply }); },
  });
  await nc.flush();

  let nonceN = 0;
  const nonce = () => `n${String(nonceN++).padStart(23, "0")}`;
  const req = (over: Record<string, unknown> = {}) => ({
    v: 1, id: "req-1", op: { endpoint: "manager", command: "status", inputDigest: D_IN, outputDigest: D_OUT },
    class: "ephemeral", replyExpected: true, deadlineMs: 2000, args: { name: "x" }, from: { id: "u_abc.worker", name: "w" }, ...over,
  });
  const send = async (subject: string, body: unknown) => {
    nc.publish(subject, new TextEncoder().encode(JSON.stringify(body)));
    await nc.flush();
    for (let i = 0; i < 40 && replies.length === 0; i++) await wait(50);
    return replies.shift();
  };
  const oneSubj = (cmd2: string, extra: Record<string, unknown> = {}) =>
    epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: cmd2, caller, nonce: nonce(), ...extra });

  // call on the one rail: queue-group anycast, exactly one instance answers
  const r1 = await send(oneSubj("status"), req());
  await wait(200);
  c("a class call is answered EXACTLY once (queue-group anycast)",
    r1 !== undefined && r1.reply.ok === true && replies.length === 0,
    JSON.stringify(r1));
  const attr1 = parseEpSubject(r1!.subject);
  c("the reply subject attributes the responding instance + epoch (structural, never body)",
    attr1?.plane === "reply"
    && ((attr1.instanceId === IID_A && attr1.epoch === 3 && (r1!.reply.data as { which: string }).which === "A")
      || (attr1.instanceId === IID_B && attr1.epoch === 1 && (r1!.reply.data as { which: string }).which === "B")));

  // inst rail addresses ONE stable instance
  const r2 = await send(epRequestSubject(SPACE, { route: { mode: "inst", instanceId: IID_B }, endpoint: "manager", command: "status", caller, nonce: nonce() }), req());
  c("an instance call lands on exactly the addressed instance",
    r2 !== undefined && (r2.reply.data as { which: string }).which === "B"
    && (parseEpSubject(r2.subject) as { instanceId: string }).instanceId === IID_B);

  // all rail: every instance answers (gather semantics are D5's; here both replies arrive)
  nc.publish(epRequestSubject(SPACE, { route: { mode: "all" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), new TextEncoder().encode(JSON.stringify(req())));
  await nc.flush();
  for (let i = 0; i < 40 && replies.length < 2; i++) await wait(50);
  c("a scatter request draws one reply per instance",
    replies.length === 2
    && new Set(replies.map((r) => (parseEpSubject(r.subject) as { instanceId: string }).instanceId)).size === 2);
  replies.length = 0;

  // digest binding + runtime schema validation
  const r3 = await send(oneSubj("status"), req({ op: { endpoint: "manager", command: "status", inputDigest: D_OTHER, outputDigest: D_OUT } }));
  c("a pinned digest the member cannot honor is contract-mismatch, never coerced",
    r3 !== undefined && r3.reply.ok === false && r3.reply.error?.code === "contract-mismatch");
  const r3b = await send(oneSubj("status"), req({ args: { name: 42 } }));
  c("args violating the input schema are bad-request BEFORE any effect",
    r3b !== undefined && r3b.reply.error?.code === "bad-request");
  const r3n = await send(oneSubj("status"), req({ args: null }));
  c("explicit-null args on an OBJECT-input command are bad-request through the SCHEMA (not the parser)",
    r3n !== undefined && r3n.reply.error?.code === "bad-request", JSON.stringify(r3n?.reply));
  const r3c = await send(oneSubj("badout"), req({ op: { endpoint: "manager", command: "badout", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("handler output violating the output schema is internal, never published as success",
    r3c !== undefined && r3c.reply.ok === false && r3c.reply.error?.code === "internal");
  const r3d = await send(oneSubj("cyclic"), req({ op: { endpoint: "manager", command: "cyclic", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("a non-serializable reply is replaced by a structured internal error, never dropped",
    r3d !== undefined && r3d.reply.ok === false && r3d.reply.error?.code === "internal");
  // Tee console.error: the demoted budget's ONLY observable is its report, and asserting the reply
  // alone would pass just as well if the validation had never been over budget. Tee rather than
  // swallow, so the serve side's diagnostics still reach the log.
  const budgetReports: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { const line = a.map(String).join(" "); budgetReports.push(line); realError(line); };
  let r3e: Awaited<ReturnType<typeof send>>;
  try { r3e = await send(oneSubj("slow"), req({ op: { endpoint: "manager", command: "slow", inputDigest: D_IN, outputDigest: D_SLOW } })); }
  finally { console.error = realError; }
  // This leg used to assert the §13.8 budget refused an over-budget OUTPUT as `internal`. The
  // budget now REPORTS on the request path, so that throw is gone — and removing it exposed a hole
  // it had been masking. This payload is schema-VALID and ~125MB serialized, so the serve path now
  // reaches the publish, the broker refuses it over `max_payload`, and the throw escaped into the
  // subscription callback's swallowed rejection: the caller got NO REPLY AT ALL and sat until its
  // own deadline. Executed, not reasoned — `r3e` came back `undefined`. endpoint-serve.ts now
  // answers `resource-exhausted` instead, so what this leg pins is the invariant the file already
  // claimed for non-serializable replies: a responder never leaves a caller with silence.
  c("an over-budget OUTPUT validation is REPORTED, not refused (the §13.8 demotion)",
    budgetReports.some((l) => /output validation took ~\d+ms/.test(l)), `reports: ${budgetReports.length}`);
  c("a reply too large to publish is answered `resource-exhausted`, never silently dropped",
    r3e !== undefined && r3e.reply.ok === false && r3e.reply.error?.code === "resource-exhausted",
    r3e === undefined ? "NO REPLY - the caller was left with silence" : JSON.stringify(r3e.reply).slice(0, 220));

  // §13.7 canonical void: absent OR explicit null args both validate on a void-input command
  const pingOp = { endpoint: "manager", command: "ping", inputDigest: D_VOID, outputDigest: D_OUT };
  const rv1 = await send(oneSubj("ping"), req({ op: pingOp, args: undefined }));
  c("a void-input command accepts ABSENT args", rv1?.reply.ok === true, JSON.stringify(rv1?.reply));
  const rv2 = await send(oneSubj("ping"), req({ op: pingOp, args: null }));
  c("a void-input command accepts EXPLICIT NULL args (SPEC 13.7: absent or null)",
    rv2?.reply.ok === true, JSON.stringify(rv2?.reply));
  const rv3 = await send(oneSubj("ping"), req({ op: pingOp }));
  c("a void-input command rejects an object payload (the void schema decides)",
    rv3 !== undefined && rv3.reply.error?.code === "bad-request", JSON.stringify(rv3?.reply));

  // class discipline: a journal-declared call on a rail dies at the boundary (§13.4: a journal
  // submission is a cast observing its decision subtree, so journal+replyExpected:true is the
  // envelope's own bad-request; a WELL-FORMED journal cast is silent by §13.5 and the class
  // seam guards it without a reply to witness).
  const r4 = await send(oneSubj("status"), req({ class: "journal" }));
  c("a journal-class call on a rail is refused at the boundary",
    r4 !== undefined && r4.reply.ok === false && r4.reply.error?.code === "bad-request");

  // body-subject agreement
  const r5 = await send(oneSubj("status"), req({ op: { endpoint: "other", command: "status", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("a body op disagreeing with the subject is op-mismatch",
    r5 !== undefined && r5.reply.error?.code === "op-mismatch");

  // a malformed body still answers the call boundary (the reply subject is nonce-scoped)
  const r6 = await send(oneSubj("status"), { v: 1, id: "req-x" });
  c("a malformed call body draws a structured boundary error",
    r6 !== undefined && r6.reply.ok === false && typeof r6.reply.error?.code === "string");

  // target currency (§13.3/§13.9): fresh mapping immediately before effect, on the REGISTERED
  // targeted command (inspect: targeted, modes [owner]).
  const tgt = { mode: "owner" as const, tOwner: "u_abc" };
  const iOp = { endpoint: "manager", command: "inspect", inputDigest: D_IN, outputDigest: D_OUT };
  const iReq = (t: Record<string, unknown>) => req({ op: iOp, target: t });
  const r7a = await send(oneSubj("inspect", { target: tgt }), iReq({ owner: "u_abc", actor: "svc", lifecycleUid: T_UID }));
  c("a CURRENT target dispatches", r7a !== undefined && r7a.reply.ok === true, JSON.stringify(r7a?.reply));
  const r7b = await send(oneSubj("inspect", { target: tgt }), iReq({ owner: "u_abc", actor: "svc", lifecycleUid: OTHER_UID }));
  c("a superseded/foreign target lifecycleUid is expired (fresh mapping, not static agreement)",
    r7b !== undefined && r7b.reply.error?.code === "expired");
  const r7c = await send(oneSubj("inspect", { target: tgt }), iReq({ owner: "u_abc", actor: "svc", lifecycleUid: T_UID, mappingRevision: 3 }));
  c("a pinned mappingRevision that is not the current one is expired (the pin is exact)",
    r7c !== undefined && r7c.reply.error?.code === "expired");
  const r7d = await send(oneSubj("inspect", { target: tgt }), iReq({ owner: "u_abc", actor: "gone", lifecycleUid: T_UID }));
  c("a target alias with NO current mapping is expired",
    r7d !== undefined && r7d.reply.error?.code === "expired");
  // no resolver seam = targeted modes REFUSED, never dispatched unchecked. manager2 registers a
  // NARROW single-command cluster (its whole surface is `inspect`), per the full-surface rule.
  await reg(kv, { spec: { endpoint: "manager2", owner: "u_op", clusterDigests: [DC_INSPECT], protocol: { v: 1 } }, instanceId: IID_A, registrant: asOp, authority });
  const grant2 = await authorizeServeGrant(kv, {
    space: SPACE, endpoint: "manager2", instanceId: IID_A, epoch: 1,
    holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact,
  });
  const srvNoRes = serveEndpoint(nc, SPACE, grant2, [def("inspect")], { public: true });
  await nc.flush();
  const r7e = await send(
    epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager2", command: "inspect", caller, nonce: nonce(), target: tgt }),
    req({ op: { ...iOp, endpoint: "manager2" }, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } }));
  c("a targeted request with NO resolver seam is unavailable (fail closed, never unchecked dispatch)",
    r7e !== undefined && r7e.reply.error?.code === "unavailable");
  await srvNoRes.stop();

  // §13.2/§13.7 registered admission: default-deny both ways
  const r7f = await send(oneSubj("inspect", { target: { mode: "any", tOwner: "u_abc" } }),
    iReq({ owner: "u_abc", actor: "svc", lifecycleUid: T_UID }));
  c("an UNREGISTERED authorization mode is permission-denied (inspect admits only owner)",
    r7f !== undefined && r7f.reply.error?.code === "permission-denied");
  const r7g = await send(oneSubj("badout", { target: tgt }),
    req({ op: { endpoint: "manager", command: "badout", inputDigest: D_IN, outputDigest: D_OUT }, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } }));
  c("a registered-UNTARGETED command refuses every targeted form (default-deny)",
    r7g !== undefined && r7g.reply.error?.code === "permission-denied");

  // §13.2 child/ledger: fresh per-mode authorization through the seams, fail closed without them
  const childCalls: { caller: EpCaller; target: { owner: string; actor: string; lifecycleUid: string } }[] = [];
  const ledgerCalls: { op: { endpoint: string; command: string } }[] = [];
  let adoptRuns = 0;
  let childAnswer: boolean | Error = true;
  let ledgerAnswer = true;
  let rotateDuringSeam = false;
  const m3Defs = (): EpCommandDef[] => [
    def("adopt", { handler: () => { adoptRuns++; return { which: "c" }; } }),
    def("audit", { handler: () => ({ which: "l" }) }),
  ];
  await reg(kv, { spec: { endpoint: "manager3", owner: "u_op", clusterDigests: [DC_REL], protocol: { v: 1 } }, instanceId: IID_A, registrant: asOp, authority });
  const grant3 = await authorizeServeGrant(kv, {
    space: SPACE, endpoint: "manager3", instanceId: IID_A, epoch: 1,
    holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact,
  });
  const m3Subj = (cmd3: string, mode: "child" | "ledger") =>
    epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager3", command: cmd3, caller, nonce: nonce(), target: { mode, tOwner: "u_abc" } });
  const m3Req = (cmd3: string) =>
    req({ op: { endpoint: "manager3", command: cmd3, inputDigest: D_IN, outputDigest: D_OUT }, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } });
  const srvNoSeam = serveEndpoint(nc, SPACE, grant3, m3Defs(), { public: true }, { resolveTarget });
  await nc.flush();
  const r11a = await send(m3Subj("adopt", "child"), m3Req("adopt"));
  c("a child-mode request with NO spawner seam is unavailable (fail closed, never the grant alone)",
    r11a !== undefined && r11a.reply.error?.code === "unavailable");
  const r11b = await send(m3Subj("audit", "ledger"), m3Req("audit"));
  c("a ledger-mode request with NO ledger seam is unavailable (fail closed)",
    r11b !== undefined && r11b.reply.error?.code === "unavailable");
  await srvNoSeam.stop();
  const srvSeamed = serveEndpoint(nc, SPACE, grant3, m3Defs(), { public: true }, {
    resolveTarget,
    childAuthority: async (a) => {
      childCalls.push(a);
      if (rotateDuringSeam) {
        await wait(150); // the mapping rotates WHILE the spawner record is being read
        targets.set("u_abc.svc", { lifecycleUid: OTHER_UID, mappingRevision: 8 });
        return true;
      }
      if (childAnswer instanceof Error) throw childAnswer;
      return childAnswer;
    },
    ledgerAuthority: (a) => { ledgerCalls.push(a); return ledgerAnswer; },
  });
  await nc.flush();
  // The finding-5 regression: a TARGETED-only command invoked UNTARGETED must refuse at
  // admission — the handler never runs and the spawner seam is never consulted.
  const r11u = await send(
    epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager3", command: "adopt", caller, nonce: nonce() }),
    req({ op: { endpoint: "manager3", command: "adopt", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("a registered-TARGETED command refuses the UNTARGETED form; handler and seam are never reached",
    r11u !== undefined && r11u.reply.error?.code === "permission-denied" && adoptRuns === 0 && childCalls.length === 0,
    JSON.stringify({ r: r11u?.reply, adoptRuns, childCalls: childCalls.length }));
  const r11c = await send(m3Subj("adopt", "child"), m3Req("adopt"));
  c("a spawner-confirmed child-mode request dispatches, the seam fed the SUBJECT-borne caller",
    r11c !== undefined && r11c.reply.ok === true
    && childCalls[0]?.caller.actor === "worker" && childCalls[0]?.target.lifecycleUid === T_UID,
    JSON.stringify({ r: r11c?.reply, calls: childCalls }));
  childAnswer = false;
  const r11d = await send(m3Subj("adopt", "child"), m3Req("adopt"));
  c("a spawner record NOT naming the caller is permission-denied (fresh check, not the grant)",
    r11d !== undefined && r11d.reply.error?.code === "permission-denied");
  childAnswer = new Error("registry read failed");
  const r11e = await send(m3Subj("adopt", "child"), m3Req("adopt"));
  c("a FAILING spawner seam is unavailable (fail closed, never dispatched on doubt)",
    r11e !== undefined && r11e.reply.error?.code === "unavailable");
  // The finding-6 regression: the mapping rotates DURING the child-authority await — the
  // post-seam currency re-read must refuse `expired`, and the handler must never run.
  childAnswer = true;
  rotateDuringSeam = true;
  const adoptBefore = adoptRuns;
  const r11h = await send(m3Subj("adopt", "child"), m3Req("adopt"));
  c("a mapping ROTATED during the authority read is expired at the post-seam re-check; no effect happens",
    r11h !== undefined && r11h.reply.error?.code === "expired" && adoptRuns === adoptBefore,
    JSON.stringify({ r: r11h?.reply, adoptRuns, adoptBefore }));
  rotateDuringSeam = false;
  targets.set("u_abc.svc", { lifecycleUid: T_UID, mappingRevision: 7 });
  const r11f = await send(m3Subj("audit", "ledger"), m3Req("audit"));
  c("a ledger-granted request dispatches, the seam fed the exact op",
    r11f !== undefined && r11f.reply.ok === true
    && ledgerCalls[0]?.op.endpoint === "manager3" && ledgerCalls[0]?.op.command === "audit");
  ledgerAnswer = false;
  const r11g = await send(m3Subj("audit", "ledger"), m3Req("audit"));
  c("a ledger with no live grant is permission-denied (fresh read, fail closed)",
    r11g !== undefined && r11g.reply.error?.code === "permission-denied");
  await srvSeamed.stop();

  // cast: at-most-once, never replied to — even when the handler throws
  const castBefore = castRuns;
  nc.publish(oneSubj("poke"), new TextEncoder().encode(JSON.stringify(req({ op: { endpoint: "manager", command: "poke", inputDigest: D_IN, outputDigest: D_OUT }, replyExpected: false, deadlineMs: undefined }))));
  await nc.flush();
  for (let i = 0; i < 20 && castRuns === castBefore; i++) await wait(50);
  await wait(300);
  c("a cast runs its handler and the responder never replies (even on handler failure)",
    castRuns === castBefore + 1 && replies.length === 0, `castRuns ${castRuns} replies ${replies.length}`);

  // describe: authorization-scoped answers off the broker-authenticated caller, over the
  // artifact's DERIVED descriptor
  const dReq = req({ op: { endpoint: "manager", command: "describe" }, args: undefined });
  const r8 = await send(oneSubj("describe"), dReq);
  const answer = r8?.reply.data as DescribeAnswer | undefined;
  c("describe answers scoped: exactly the authorized command intersection per verified cluster",
    r8?.reply.ok === true && answer?.public === false
    && answer.descriptor.clusters.length === 2
    && JSON.stringify(answer.descriptor.clusters[0].commands) === JSON.stringify(["status", "badout", "cyclic"])
    && JSON.stringify(answer.descriptor.clusters[1].commands) === JSON.stringify(["extra"]),
    JSON.stringify(answer));
  c("a PARTIAL cluster intersection omits the inline document (digest-only; no unauthorized leak)",
    answer !== undefined && answer.descriptor.clusters[0].document === undefined);
  c("a FULL cluster intersection keeps its inline (verified) document",
    answer !== undefined && answer.descriptor.clusters[1].document !== undefined);
  const r8b = await send(oneSubj("describe"), req({ op: { endpoint: "manager", command: "describe", inputDigest: D_IN, outputDigest: D_OUT }, args: undefined }));
  c("a digest carried on describe is contract-mismatch (nothing to honor)",
    r8b !== undefined && r8b.reply.error?.code === "contract-mismatch");
  const viewsBefore = viewCalls;
  const r8c = await send(oneSubj("describe"), req({ op: { endpoint: "manager", command: "describe" }, args: { name: "x" } }));
  c("describe with non-void args is bad-request BEFORE the authorization-view lookup",
    r8c !== undefined && r8c.reply.error?.code === "bad-request" && viewCalls === viewsBefore,
    JSON.stringify({ r: r8c?.reply, viewsBefore, viewCalls }));
  const r8n = await send(oneSubj("describe"), req({ op: { endpoint: "manager", command: "describe" }, args: null }));
  c("describe accepts EXPLICIT NULL args (canonical void: absent or null, SPEC 13.7)",
    r8n?.reply.ok === true, JSON.stringify(r8n?.reply));
  const r8d = await send(oneSubj("describe", { target: tgt }), req({ op: { endpoint: "manager", command: "describe" }, args: undefined, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } }));
  c("a TARGETED describe is permission-denied (reserved untargeted, SPEC 13.7)",
    r8d !== undefined && r8d.reply.error?.code === "permission-denied");
  // Finding-4 (mutable authz) regression: flip the caller-supplied authz to {public:true} AFTER
  // construction — the snapshotted scoped policy must ignore it and never leak the full surface.
  (scoped as { public?: boolean }).public = true;
  const r8m = await send(oneSubj("describe"), dReq);
  c("a post-construction authz mutation ({view}->{public:true}) does NOT change the snapshotted policy",
    (r8m?.reply.data as DescribeAnswer | undefined)?.public === false, JSON.stringify(r8m?.reply));
  delete (scoped as { public?: boolean }).public;

  // stop(): drains AND awaits in-flight handlers before reporting stopped
  gateArmed = true; // the next status handler parks until released
  nc.publish(epRequestSubject(SPACE, { route: { mode: "inst", instanceId: IID_A }, endpoint: "manager", command: "status", caller, nonce: nonce() }), new TextEncoder().encode(JSON.stringify(req())));
  await nc.flush();
  for (let i = 0; i < 60 && gate === undefined; i++) await wait(25); // the handler is parked once gate is set
  c("the gated handler is in flight", gate !== undefined);
  let stopped: boolean | undefined;
  const stopping = srvA.stop().then(() => { stopped = true; });
  await wait(400);
  c("stop() does NOT report stopped while a handler is in flight", stopped !== true);
  gate!();
  await stopping;
  c("stop() resolves once the in-flight handler finishes", stopped === true);
  await srvB.stop();
  await wait(200);
  replies.length = 0; // the released handler still published its (valid) reply; clear it

  // an answerless trusted view fails CLOSED; a public descriptor consults no view. Re-authorize
  // the (still-current) manager IID_A/epoch 3 and serve its full surface for the describe probes.
  const grantD = await authorizeA();
  const srvClosed = serveEndpoint(nc, SPACE, grantD, fullDefs(), { view: () => undefined });
  await nc.flush();
  const r9 = await send(oneSubj("describe"), dReq);
  c("describe with no fresh trusted view is unavailable (fail closed, never a weaker source)",
    r9 !== undefined && r9.reply.ok === false && r9.reply.error?.code === "unavailable");
  await srvClosed.stop();
  const srvPub = serveEndpoint(nc, SPACE, grantD, fullDefs(), { public: true });
  await nc.flush();
  const r10 = await send(oneSubj("describe"), dReq);
  const pub = r10?.reply.data as DescribeAnswer | undefined;
  c("a declared-public descriptor answers unscoped and SAYS it is public",
    pub?.public === true && pub.descriptor.clusters[0].commands.includes("status"), JSON.stringify(pub));
  await srvPub.stop();

  // ---- finding 4: journal-only and MIXED endpoints construct and serve mandatory describe ----
  // A journal command stays in the credential/descriptor surface but rides epj, so it takes no
  // rail def; exact handler coverage applies to the EPHEMERAL subset only. The old contradiction
  // (full-surface coverage vs journal-def rejection) made these endpoints unable to serve describe.
  replies.length = 0;
  const describeOn = async (endpoint: string) => {
    const subj = epRequestSubject(SPACE, { route: { mode: "one" }, endpoint, command: "describe", caller, nonce: nonce() });
    nc.publish(subj, new TextEncoder().encode(JSON.stringify({ v: 1, id: "req-d", op: { endpoint, command: "describe" }, class: "ephemeral", replyExpected: true, deadlineMs: 2000, args: undefined, from: { id: "u_abc.worker", name: "w" } })));
    await nc.flush();
    for (let i = 0; i < 40 && replies.length === 0; i++) await wait(50);
    return replies.shift();
  };
  // journal-ONLY (mgrjob: submitjob is journal) — constructs with NO ephemeral defs, serves describe.
  const srvJournal = serveEndpoint(nc, SPACE, grantJournal, [], { public: true });
  await nc.flush();
  const rj = await describeOn("mgrjob");
  const ja = rj?.reply.data as DescribeAnswer | undefined;
  c("a JOURNAL-ONLY endpoint constructs serveEndpoint (no ephemeral defs) and serves mandatory describe (SPEC 13.7)",
    rj?.reply.ok === true && ja?.public === true && ja.descriptor.clusters.some((cl) => cl.commands.includes("submitjob")), JSON.stringify(rj?.reply));
  await srvJournal.stop();
  // MIXED (mgrmix: ephemeral "run" + journal "submitjob") — constructs with the ephemeral def
  // ONLY; describe advertises BOTH; and the ephemeral rail actually serves.
  await reg(kv, { spec: { endpoint: "mgrmix", owner: "u_op", clusterDigests: [DC_MIXED], protocol: { v: 1 } }, instanceId: IID_A, registrant: asOp, authority });
  const grantMixed = await authorizeServeGrant(kv, { space: SPACE, endpoint: "mgrmix", instanceId: IID_A, epoch: 1, holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact });
  const srvMixed = serveEndpoint(nc, SPACE, grantMixed, [def("run")], { public: true });
  await nc.flush();
  const rm = await describeOn("mgrmix");
  const ma = rm?.reply.data as DescribeAnswer | undefined;
  c("a MIXED (ephemeral+journal) endpoint constructs with the ephemeral def only and serves describe advertising BOTH commands",
    rm?.reply.ok === true && !!ma && ma.descriptor.clusters.some((cl) => cl.commands.includes("run") && cl.commands.includes("submitjob")), JSON.stringify(rm?.reply));
  const runSubj = epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "mgrmix", command: "run", caller, nonce: nonce() });
  nc.publish(runSubj, new TextEncoder().encode(JSON.stringify({ v: 1, id: "req-run", op: { endpoint: "mgrmix", command: "run", inputDigest: D_IN, outputDigest: D_OUT }, class: "ephemeral", replyExpected: true, deadlineMs: 2000, args: { name: "x" }, from: { id: "u_abc.worker", name: "w" } })));
  await nc.flush();
  for (let i = 0; i < 40 && replies.length === 0; i++) await wait(50);
  const rr = replies.shift();
  c("the MIXED endpoint's EPHEMERAL rail serves (journal siblings do not block construction or serving)", rr?.reply.ok === true, JSON.stringify(rr?.reply));
  await srvMixed.stop();

  // ---- the registry-wired caller entry points (§13.5/§13.2): production hooks end to end ----
  {
    const EPC = "clsvc";
    const regCA = await reg(kv, { spec: { endpoint: EPC, owner: "u_op", clusterDigests: [DC_MAIN, DC_AUX], protocol: { v: 1 } }, instanceId: IID_A, registrant: asOp, authority });
    await writeServiceStatus(kv, { endpoint: EPC, instanceId: IID_A, epoch: 3, readProcessEpoch: () => 3, status: { epoch: 3, state: SERVICE_READY, observedSpecRevision: regCA.registrationRevision } });
    const regCB = await reg(kv, { spec: { endpoint: EPC, owner: "u_op", clusterDigests: [DC_MAIN, DC_AUX], protocol: { v: 1 } }, instanceId: IID_B, registrant: asOp, authority });
    await writeServiceStatus(kv, { endpoint: EPC, instanceId: IID_B, epoch: 1, readProcessEpoch: () => 1, status: { epoch: 1, state: SERVICE_READY, observedSpecRevision: regCB.registrationRevision } });
    const grantCA = await authorizeServeGrant(kv, { space: SPACE, endpoint: EPC, instanceId: IID_A, epoch: 3, holder: asOp, authority, readProcessEpoch: () => 3, readClusterArtifact });
    const grantCB = await authorizeServeGrant(kv, { space: SPACE, endpoint: EPC, instanceId: IID_B, epoch: 1, holder: asOp, authority, readProcessEpoch: () => 1, readClusterArtifact });
    const srvCA = serveEndpoint(nc, SPACE, grantCA, commandsFor("A"), scoped, { resolveTarget });
    const srvCB = serveEndpoint(nc, SPACE, grantCB, commandsFor("B"), scoped, { resolveTarget });
    await nc.flush();
    const opC = (command: string): EpVerbOp => ({ endpoint: EPC, command, contract: { input: argsContract, output: outContract }, caller, args: { name: "x" } });

    // one rail: the queue winner's currency verified against the LIVE registry status epoch
    const c1 = await epCallService(nc, jsm, SPACE, { mode: "one" }, opC("status"), { deadlineMs: 4000 });
    c("epCallService verifies the `one` winner against the live registry epoch (production reader wired)",
      c1.reply.ok === true
      && ((c1.responder.instanceId === IID_A && c1.responder.epoch === 3) || (c1.responder.instanceId === IID_B && c1.responder.epoch === 1)),
      JSON.stringify(c1.responder));
    const epochOf = serviceEpochReader(jsm, SPACE, EPC);
    c("serviceEpochReader answers the CURRENT registry epoch per instance",
      (await epochOf(IID_A)) === 3 && (await epochOf(IID_B)) === 1);
    await rejects("serviceEpochReader refuses an UNREGISTERED instance (the read's own failure, never mislabeled staleness)",
      () => epochOf("z".repeat(26)), "failed-precondition");

    // scatter: freeze -> gather -> production reconcile, one call
    const s1 = await epScatterService(nc, jsm, SPACE, opC("status"), { deadlineMs: 4000 });
    c("epScatterService freezes from the LIVE registry and completes over both instances",
      s1.complete === true && s1.replies.size === 2 && s1.churn.length === 0 && s1.missing.length === 0 && s1.invalid.length === 0,
      JSON.stringify({ complete: s1.complete, replies: s1.replies.size, churn: s1.churn, missing: s1.missing, invalid: s1.invalid }));
    // distsys BLOCKING 2: the FREEZE is charged against the ONE deadline. A stalled enumeration is
    // deadline-exceeded within the budget, never a scatter that silently overruns it.
    // RE-POINTED for the consumer-free enumeration: the freeze stalls on STREAM.INFO now, not on
    // `kv.keys`. Stalling a call the code no longer makes left this cell reporting "no throw" — the
    // fixture aimed at a deleted call site, which is the exact class this suite exists to catch.
    // ONLY `streams.info` stalls: the per-slot leader reads use other jsm methods and must stay
    // live, or this would prove "a stalled everything" rather than "a stalled enumeration".
    // Mutation-proved: pass `info` through to the real jsm and this cell reports "no throw".
    const stalledJsm = Object.create(jsm) as typeof jsm;
    (stalledJsm as unknown as { streams: unknown }).streams = Object.assign(Object.create(jsm.streams as object), {
      info: () => new Promise(() => { /* never settles */ }),
    });
    await rejects("epScatterService charges the freeze against the deadline (a stalled enumeration is deadline-exceeded)",
      () => epScatterService(nc, stalledJsm, SPACE, opC("status"), { deadlineMs: 200 }), "deadline-exceeded");
    {
      // The stalled freeze is the CALLER's registry read failing before any request goes out: it
      // carries EP_REGISTRY_READ_FAILED and never EP_UNANSWERED, so a consumer does not print a
      // reachability verdict for a read that asked nobody.
      let e: unknown;
      try { await epScatterService(nc, stalledJsm, SPACE, opC("status"), { deadlineMs: 200 }); } catch (err) { e = err; }
      c("a stalled freeze is marked EP_REGISTRY_READ_FAILED (the caller's own registry read), not EP_UNANSWERED", registryReadFailed(e) && !unansweredRequest(e), e);
    }

    // a REAL mid-scatter re-registration: the production reconciler observes the revision
    // advance the reply rail cannot see and classifies `registration` churn (§13.5)
    const frozen1 = await freezeExpectedSet(jsm, SPACE, EPC);
    const regCB2 = await reg(kv, { spec: { endpoint: EPC, owner: "u_op", clusterDigests: [DC_MAIN, DC_AUX], protocol: { v: 1 } }, instanceId: IID_B, registrant: asOp, authority });
    const s2 = await epScatter(nc, SPACE, opC("status"), { deadlineMs: 4000, expected: frozen1, reconcileRegistration: registrationReconciler(jsm, SPACE, EPC, frozen1) });
    c("a mid-scatter re-registration is `registration` churn through the PRODUCTION reconciler (counted reply dropped)",
      s2.complete === false && s2.churn.some((x) => x.instanceId === IID_B && x.reason === "registration")
      && s2.replies.has(IID_A) && !s2.replies.has(IID_B),
      JSON.stringify({ complete: s2.complete, churn: s2.churn, replies: [...s2.replies.keys()] }));

    // a REAL mid-scatter deregistration: the explicit registered:false verdict — a departure
    // does NOT invalidate the reply the departed instance already gave (§13.5)
    await writeServiceStatus(kv, { endpoint: EPC, instanceId: IID_B, epoch: 1, readProcessEpoch: () => 1, status: { epoch: 1, state: SERVICE_READY, observedSpecRevision: regCB2.registrationRevision } });
    const frozen2 = await freezeExpectedSet(jsm, SPACE, EPC);
    c("(setup) the re-converged freeze holds both instances again", frozen2.length === 2);
    await kv.delete(recordSpecKey(RECORD_KINDS.svc, [EPC, IID_B]));
    await kv.delete(recordStatusKey(RECORD_KINDS.svc, [EPC, IID_B]));
    const s3 = await epScatter(nc, SPACE, opC("status"), { deadlineMs: 4000, expected: frozen2, reconcileRegistration: registrationReconciler(jsm, SPACE, EPC, frozen2) });
    c("a mid-scatter DEREGISTRATION keeps the departed instance's valid reply counted (explicit registered:false, not churn)",
      s3.complete === true && s3.replies.size === 2 && s3.churn.length === 0,
      JSON.stringify({ complete: s3.complete, replies: [...s3.replies.keys()], churn: s3.churn }));

    await srvCA.stop();
    await srvCB.stop();
    replies.length = 0;
  }

  await replySub.drain();
  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(`\nENDPOINT SERVE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
