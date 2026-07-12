/**
 * v0.4 service-registry + serve/describe smoke (SPEC §13.2/§13.5/§13.7/§13.9) against a real
 * broker: registration CAS + registrationRevision semantics with authenticated-registrant
 * binding, the three-part status-write fence (spec coherence, fresh mapping equality, stored
 * conflict), the hardened scatter freeze, the mint-side serve-grant authorization (branded
 * tuples off the registered spec, current-epoch fence), queue-grouped class serving vs scatter
 * vs instance rails, digest-bound COMPILED contracts with the symmetric budgeted runtime
 * validation, registered target-mode admission plus the child/ledger fresh-authorization
 * seams, target currency, cast silence, awaited stop, and the spec-bound authorization-scoped
 * describe (void args, inline-document projection).
 *
 * Run: pnpm smoke:ep-serve   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, EpEnvelopeError,
  openRecordsBucket,
  parseServiceSpec, parseServiceStatus, assertServiceNameAuthority,
  registerServiceInstance, writeServiceStatus, freezeExpectedSet,
  authorizeServeGrant, assertServeGrantAuthorized,
  SERVICE_READY, SERVICE_EXITED,
  serveEndpoint, assertDescriptorMatchesSpec,
  compileContract,
  epRequestSubject, epCallerReplyFilter, parseEpSubject, recordSpecKey, RECORD_KINDS,
  type ServiceSpec, type ServiceNameAuthority, type EpCaller, type EndpointReply,
  type EpServeIdentity, type EpCommandDef, type DescribeAnswer, type DescribeDescriptor,
  type CompiledContract,
} from "../src/index.js";

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
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

// Real §13.7 contracts: the closure digests ARE the pinned op digests.
const argsContract = compileContract({ root: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } });
const outContract = compileContract({ root: { type: "object", properties: { which: { type: "string" } }, required: ["which"], additionalProperties: false } });
const D_IN = argsContract.closureDigest;
const D_OUT = outContract.closureDigest;
const D_OTHER = `sha256:${"f".repeat(64)}`;

const authority: ServiceNameAuthority = {
  isOperatorOwner: (o) => o === "u_op",
  domainOwnerOf: (name) => (name === "com.acme.builds" ? "u_acme" : undefined),
};

// ── name authority (broker-free) ──
c("a core name under the operator owner admits",
  (assertServiceNameAuthority("manager", "u_op", authority), true));
throws("a core name under a non-operator owner refuses",
  () => assertServiceNameAuthority("manager", "u_abc", authority), "permission-denied");
c("a reverse-DNS name under its registered owner admits",
  (assertServiceNameAuthority("com.acme.builds", "u_acme", authority), true));
throws("a reverse-DNS name under a foreign owner refuses",
  () => assertServiceNameAuthority("com.acme.builds", "u_abc", authority), "permission-denied");
throws("an UNREGISTERED reverse-DNS name fails closed (never first-come adoption)",
  () => assertServiceNameAuthority("com.evil.squat", "u_abc", authority), "permission-denied");

// ── descriptor validators (broker-free) ──
const spec: ServiceSpec = {
  endpoint: "manager", owner: "u_op", clusterDigests: [D_IN], protocol: { v: 1 },
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

// ── serve-table construction rules (broker-free; nc unused before subscribe) ──
const goodDef = (over: Partial<EpCommandDef> = {}): EpCommandDef => ({
  command: "status", class: "ephemeral", contract: { input: argsContract, output: outContract },
  targetModes: ["owner"],
  handler: () => ({ which: "x" }), ...over,
});
const goodDescriptor = (over: Partial<DescribeDescriptor> = {}): DescribeDescriptor => ({
  endpoint: "manager", owner: "u_op", protocol: { v: 1 },
  clusters: [{ digest: D_IN, commands: ["status"] }], ...over,
});
const idX: EpServeIdentity = { endpoint: "manager", instanceId: IID_A, epoch: 1 };
const describeOf = (descriptor: DescribeDescriptor) =>
  ({ descriptor, authz: { public: true } as const, spec: { endpoint: descriptor.endpoint, owner: descriptor.owner, clusterDigests: descriptor.clusters.map((cl) => cl.digest) } });
throws("a journal-class command def refuses at construction (journal work rides epj)",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef({ class: "journal" })], describeOf(goodDescriptor())));
throws("a def carrying raw digest strings instead of COMPILED contracts refuses at construction",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef({ contract: { inputDigest: D_IN, outputDigest: D_OUT } as never })], describeOf(goodDescriptor())));
throws("a def without contracts refuses at construction",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef({ contract: undefined as never })], describeOf(goodDescriptor())));
throws("a def registering an unknown target mode refuses at construction",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef({ targetModes: ["boss" as never] })], describeOf(goodDescriptor())));
throws("a custom describe def refuses at construction (the authorization seam is not replaceable)",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef({ command: "describe" })], describeOf(goodDescriptor())));
throws("a descriptor naming another endpoint refuses at construction",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef()], { ...describeOf(goodDescriptor({ endpoint: "other" })), spec }));
throws("a descriptor advertising a command with no handler refuses at construction",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef()], describeOf(goodDescriptor({ clusters: [{ digest: D_IN, commands: ["status", "stop"] }] }))));
throws("a descriptor that does not match the REGISTERED spec refuses at construction",
  () => serveEndpoint(null as never, SPACE, idX, [goodDef()], { descriptor: goodDescriptor(), authz: { public: true }, spec: { ...spec, clusterDigests: [D_OTHER] } }));
c("assertDescriptorMatchesSpec binds descriptor identity to the registered spec",
  (assertDescriptorMatchesSpec(goodDescriptor(), spec), true));
throws("a descriptor whose cluster digests differ from the registered spec refuses",
  () => assertDescriptorMatchesSpec(goodDescriptor({ clusters: [{ digest: D_OTHER, commands: ["status"] }] }), spec));
throws("a descriptor claiming another owner than the registered spec refuses",
  () => assertDescriptorMatchesSpec(goodDescriptor({ owner: "u_abc" }), spec));

// ── unreadable registry (stubbed KV: the read boundary itself fails) ──
await rejects("an UNREADABLE registry is failed-precondition, never an empty success",
  () => freezeExpectedSet({ keys: () => { throw new Error("permissions violation"); } } as never, "manager"), "failed-precondition");

// ── live broker ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epserve-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

  // ---- registry over the records KV ----
  const kv = await openRecordsBucket(nc, SPACE, { create: true });
  const asOp = { owner: "u_op" };

  const regA = await registerServiceInstance(kv, { spec, instanceId: IID_A, registrant: asOp, authority });
  c("registration writes the spec and returns its store revision", regA.registrationRevision >= 1);
  const regA2 = await registerServiceInstance(kv, { spec, instanceId: IID_A, registrant: asOp, authority });
  c("re-registration ADVANCES registrationRevision (scatter churn detection, SPEC 13.5)",
    regA2.registrationRevision > regA.registrationRevision);
  await rejects("a registration whose authenticated caller is not the descriptor owner refuses (impersonation)",
    () => registerServiceInstance(kv, { spec, instanceId: IID_A, registrant: { owner: "u_abc" }, authority }), "permission-denied");
  await rejects("a registration under an unauthorized claimed owner refuses",
    () => registerServiceInstance(kv, { spec: { ...spec, owner: "u_abc" }, instanceId: IID_A, registrant: { owner: "u_abc" }, authority }), "permission-denied");
  // Ownership stability across authority drift: the SAME name re-minted to a new owner cannot
  // take over an instanceId registered under the old one.
  const acmeSpec: ServiceSpec = { endpoint: "com.acme.builds", owner: "u_acme", clusterDigests: [D_IN], protocol: { v: 1 } };
  await registerServiceInstance(kv, { spec: acmeSpec, instanceId: IID_A, registrant: { owner: "u_acme" }, authority });
  const driftedAuthority: ServiceNameAuthority = { ...authority, domainOwnerOf: () => "u_evil" };
  await rejects("a re-registration cannot change an instance's ownership (id reuse across identities)",
    () => registerServiceInstance(kv, { spec: { ...acmeSpec, owner: "u_evil" }, instanceId: IID_A, registrant: { owner: "u_evil" }, authority: driftedAuthority }), "permission-denied");

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
  const regB = await registerServiceInstance(kv, { spec, instanceId: IID_B, registrant: asOp, authority });
  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_B, epoch: 1, readProcessEpoch: () => 1, status: { epoch: 1, state: SERVICE_READY, observedSpecRevision: regB.registrationRevision } });
  const frozen = await freezeExpectedSet(kv, "manager");
  c("the frozen expected set carries (instanceId, registrationRevision, epoch) per live instance",
    frozen.length === 2
    && frozen.some((f) => f.instanceId === IID_A && f.registrationRevision === regA2.registrationRevision && f.epoch === 3)
    && frozen.some((f) => f.instanceId === IID_B && f.registrationRevision === regB.registrationRevision && f.epoch === 1));
  // A stale projection is NOT live under the current registration: re-register B (spec revision
  // advances) while its status still observes the old revision — freezing (new rev, old epoch)
  // would combine a registration with liveness it never had.
  const regB2 = await registerServiceInstance(kv, { spec, instanceId: IID_B, registrant: asOp, authority });
  c("a stale projection (status behind the CURRENT registration) leaves the frozen set",
    regB2.registrationRevision > regB.registrationRevision
    && (await freezeExpectedSet(kv, "manager")).every((f) => f.instanceId !== IID_B));
  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_B, epoch: 1, readProcessEpoch: () => 1, status: { epoch: 1, state: SERVICE_EXITED, observedSpecRevision: regB2.registrationRevision } });
  c("an exited instance leaves the frozen set", (await freezeExpectedSet(kv, "manager")).every((f) => f.instanceId !== IID_B));
  await rejects("an empty registry is failed-precondition, never an empty scatter success",
    () => freezeExpectedSet(kv, "ghost"), "failed-precondition");
  // Malformed mediated-writer state fails LOUD (§13.9), never enters the set.
  await kv.put(recordSpecKey(RECORD_KINDS.svc, ["manager", T_UID]), new TextEncoder().encode(JSON.stringify({ attackerControlled: true, owner: "u_evil" })));
  await kv.put(`svc.manager.${T_UID}.status`, new TextEncoder().encode(JSON.stringify({ epoch: 1, state: SERVICE_READY, observedSpecRevision: 1 })));
  await rejects("a malformed registered spec fails LOUD at the freeze, never enters the set",
    () => freezeExpectedSet(kv, "manager"), "internal");
  await kv.purge(recordSpecKey(RECORD_KINDS.svc, ["manager", T_UID]));
  await kv.purge(`svc.manager.${T_UID}.status`);

  // ---- serve-grant authorization (the mint-side §13.9 fence) ----
  const grant = await authorizeServeGrant(kv, {
    endpoint: "manager", instanceId: IID_A, epoch: 3, commands: ["status"],
    descriptor: goodDescriptor(), holder: asOp, authority, readProcessEpoch: () => 3,
  });
  c("a registered instance's serve tuple authorizes and the branded grant passes the mint check",
    (assertServeGrantAuthorized(grant), grant.endpoint === "manager" && grant.epoch === 3));
  await rejects("an UNREGISTERED instance cannot authorize a serve grant (foreign instance)",
    () => authorizeServeGrant(kv, { endpoint: "manager", instanceId: "e".repeat(26), epoch: 3, commands: ["status"], descriptor: goodDescriptor(), holder: asOp, authority, readProcessEpoch: () => 3 }), "failed-precondition");
  await rejects("a holder that is not the registered owner cannot authorize (foreign name)",
    () => authorizeServeGrant(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, commands: ["status"], descriptor: goodDescriptor(), holder: { owner: "u_abc" }, authority, readProcessEpoch: () => 3 }), "permission-denied");
  await rejects("name-authority DRIFT refuses fresh at mint (the old registration cannot keep minting)",
    () => authorizeServeGrant(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, commands: ["status"], descriptor: goodDescriptor(), holder: asOp, authority: { ...authority, isOperatorOwner: () => false }, readProcessEpoch: () => 3 }), "permission-denied");
  await rejects("a command outside the registered contract surface refuses (foreign command)",
    () => authorizeServeGrant(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, commands: ["stop"], descriptor: goodDescriptor(), holder: asOp, authority, readProcessEpoch: () => 3 }), "permission-denied");
  await rejects("an explicit describe in the minted commands refuses (derived, never minted)",
    () => authorizeServeGrant(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, commands: ["describe"], descriptor: goodDescriptor(), holder: asOp, authority, readProcessEpoch: () => 3 }), "failed-precondition");
  await rejects("a serve grant for a NON-CURRENT epoch refuses expired (only the current incarnation mints)",
    () => authorizeServeGrant(kv, { endpoint: "manager", instanceId: IID_A, epoch: 2, commands: ["status"], descriptor: goodDescriptor(), holder: asOp, authority, readProcessEpoch: () => 3 }), "expired");
  await rejects("a descriptor that does not match the registered spec refuses at authorization",
    () => authorizeServeGrant(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, commands: ["status"], descriptor: goodDescriptor({ clusters: [{ digest: D_OTHER, commands: ["status"] }] }), holder: asOp, authority, readProcessEpoch: () => 3 }));
  throws("a RAW unbranded serve tuple refuses at the mint check",
    () => assertServeGrantAuthorized({ endpoint: "manager", instanceId: IID_A, epoch: 3, commands: ["status"] }), "permission-denied");
  throws("a structural COPY of an authorized grant refuses (the brand is the object, snapshot-compared)",
    () => assertServeGrantAuthorized({ ...grant, commands: [...grant.commands] }), "permission-denied");
  throws("the authorized grant is frozen: post-authorization mutation throws instead of widening",
    () => { (grant as { epoch: number }).epoch = 99; });

  // ---- serve: two instances of one class ----
  const idA: EpServeIdentity = { endpoint: "manager", instanceId: IID_A, epoch: 2 };
  const idB: EpServeIdentity = { endpoint: "manager", instanceId: IID_B, epoch: 1 };
  let castRuns = 0;
  let gateArmed = false;
  let gate: (() => void) | undefined;
  const targets = new Map<string, { lifecycleUid: string; mappingRevision: number }>([
    [`u_abc.svc`, { lifecycleUid: T_UID, mappingRevision: 7 }],
  ]);
  const resolveTarget = (t: { owner: string; actor: string }) => targets.get(`${t.owner}.${t.actor}`);
  // A structurally-faked compiled contract whose output validator burns past the fixed §13.8
  // budget: the digest is real, the validator deliberately slow — proves the budget bites on
  // the OUTPUT side too (structured internal, never a published success).
  const slowOut = {
    closureDigest: D_OUT,
    validate: ((v: unknown) => { const end = Date.now() + 30; while (Date.now() < end) { /* spin */ } return v !== undefined; }),
  } as unknown as CompiledContract;
  const commandsFor = (which: string): EpCommandDef[] => [
    goodDef({ handler: async () => {
      if (!gateArmed) return { which };
      gateArmed = false;
      await new Promise<void>((r) => { gate = r; }); // park until the smoke releases the gate
      return { which };
    } }),
    goodDef({ command: "badout", targetModes: [], handler: () => ({ wrong: true }) }),
    goodDef({ command: "cyclic", handler: () => { const o: Record<string, unknown> = { which }; o.self = o; return o; } }),
    goodDef({ command: "poke", handler: () => { castRuns++; throw new Error("cast handlers may fail; nobody hears it"); } }),
    goodDef({ command: "slow", contract: { input: argsContract, output: slowOut }, handler: () => ({ which }) }),
  ];
  const descriptor: DescribeDescriptor = {
    endpoint: "manager", owner: "u_op", protocol: { v: 1 },
    clusters: [
      { digest: D_IN, commands: ["status", "poke"], document: { commands: ["status", "poke"], note: "inline copy" } },
      { digest: D_OUT, commands: ["badout", "cyclic"], document: { commands: ["badout", "cyclic"] } },
    ],
  };
  let viewCalls = 0;
  const scoped = { view: (who: EpCaller) => { viewCalls++; return who.owner === "u_abc" ? { commands: ["status", "badout", "cyclic"] } : undefined; } };
  const liveSpec = { endpoint: "manager", owner: "u_op", clusterDigests: [D_IN, D_OUT] };
  const srvA = serveEndpoint(nc, SPACE, idA, commandsFor("A"), { descriptor, authz: scoped, spec: liveSpec }, { resolveTarget });
  const srvB = serveEndpoint(nc, SPACE, idB, commandsFor("B"), { descriptor, authz: scoped, spec: liveSpec }, { resolveTarget });
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
  const oneSubj = (cmd: string, extra: Record<string, unknown> = {}) =>
    epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: cmd, caller, nonce: nonce(), ...extra });

  // call on the one rail: queue-group anycast, exactly one instance answers
  const r1 = await send(oneSubj("status"), req());
  await wait(200);
  c("a class call is answered EXACTLY once (queue-group anycast)",
    r1 !== undefined && r1.reply.ok === true && replies.length === 0,
    JSON.stringify(r1));
  const attr1 = parseEpSubject(r1!.subject);
  c("the reply subject attributes the responding instance + epoch (structural, never body)",
    attr1?.plane === "reply"
    && ((attr1.instanceId === IID_A && attr1.epoch === 2 && (r1!.reply.data as { which: string }).which === "A")
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
  const r3c = await send(oneSubj("badout"), req({ op: { endpoint: "manager", command: "badout", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("handler output violating the output schema is internal, never published as success",
    r3c !== undefined && r3c.reply.ok === false && r3c.reply.error?.code === "internal");
  const r3d = await send(oneSubj("cyclic"), req({ op: { endpoint: "manager", command: "cyclic", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("a non-serializable reply is replaced by a structured internal error, never dropped",
    r3d !== undefined && r3d.reply.ok === false && r3d.reply.error?.code === "internal");
  const r3e = await send(oneSubj("slow"), req({ op: { endpoint: "manager", command: "slow", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("an over-budget OUTPUT validation is structured internal (the §13.8 budget is symmetric)",
    r3e !== undefined && r3e.reply.ok === false && r3e.reply.error?.code === "internal" && /budget/.test(r3e.reply.error?.message ?? ""),
    JSON.stringify(r3e?.reply));

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

  // target currency (§13.3/§13.9): fresh mapping immediately before effect
  const tgt = { mode: "owner" as const, tOwner: "u_abc" };
  const tReq = (t: Record<string, unknown>) => req({ target: t });
  const r7a = await send(oneSubj("status", { target: tgt }), tReq({ owner: "u_abc", actor: "svc", lifecycleUid: T_UID }));
  c("a CURRENT target dispatches", r7a !== undefined && r7a.reply.ok === true);
  const r7b = await send(oneSubj("status", { target: tgt }), tReq({ owner: "u_abc", actor: "svc", lifecycleUid: "e".repeat(26) }));
  c("a superseded/foreign target lifecycleUid is expired (fresh mapping, not static agreement)",
    r7b !== undefined && r7b.reply.error?.code === "expired");
  const r7c = await send(oneSubj("status", { target: tgt }), tReq({ owner: "u_abc", actor: "svc", lifecycleUid: T_UID, mappingRevision: 3 }));
  c("a pinned mappingRevision that is not the current one is expired (the pin is exact)",
    r7c !== undefined && r7c.reply.error?.code === "expired");
  const r7d = await send(oneSubj("status", { target: tgt }), tReq({ owner: "u_abc", actor: "gone", lifecycleUid: T_UID }));
  c("a target alias with NO current mapping is expired",
    r7d !== undefined && r7d.reply.error?.code === "expired");
  // no resolver seam = targeted modes REFUSED, never dispatched unchecked
  const srvNoRes = serveEndpoint(nc, SPACE, { endpoint: "manager2", instanceId: IID_A, epoch: 1 },
    [goodDef({ handler: () => ({ which: "n" }) })],
    { descriptor: { ...descriptor, endpoint: "manager2", clusters: [{ digest: D_IN, commands: ["status"] }] }, authz: { public: true }, spec: { endpoint: "manager2", owner: "u_op", clusterDigests: [D_IN] } });
  await nc.flush();
  const r7e = await send(
    epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager2", command: "status", caller, nonce: nonce(), target: tgt }),
    req({ op: { endpoint: "manager2", command: "status", inputDigest: D_IN, outputDigest: D_OUT }, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } }));
  c("a targeted request with NO resolver seam is unavailable (fail closed, never unchecked dispatch)",
    r7e !== undefined && r7e.reply.error?.code === "unavailable");
  await srvNoRes.stop();

  // §13.2 registered-mode admission: a command serves only the modes it registered
  const r7f = await send(oneSubj("status", { target: { mode: "any", tOwner: "u_abc" } }),
    tReq({ owner: "u_abc", actor: "svc", lifecycleUid: T_UID }));
  c("an UNREGISTERED authorization mode is permission-denied (status registers only owner)",
    r7f !== undefined && r7f.reply.error?.code === "permission-denied");
  const r7g = await send(oneSubj("badout", { target: tgt }),
    req({ op: { endpoint: "manager", command: "badout", inputDigest: D_IN, outputDigest: D_OUT }, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } }));
  c("a command registering NO target modes refuses every targeted form (default-deny)",
    r7g !== undefined && r7g.reply.error?.code === "permission-denied");

  // §13.2 child/ledger: fresh per-mode authorization through the seams, fail closed without them
  const childCalls: { caller: EpCaller; target: { owner: string; actor: string; lifecycleUid: string } }[] = [];
  const ledgerCalls: { op: { endpoint: string; command: string } }[] = [];
  let childAnswer: boolean | Error = true;
  let ledgerAnswer = true;
  const m3Defs = (): EpCommandDef[] => [
    goodDef({ command: "adopt", targetModes: ["child"], handler: () => ({ which: "c" }) }),
    goodDef({ command: "audit", targetModes: ["ledger"], handler: () => ({ which: "l" }) }),
  ];
  const m3Describe = {
    descriptor: { endpoint: "manager3", owner: "u_op", protocol: { v: 1 } as const, clusters: [{ digest: D_IN, commands: ["adopt", "audit"] }] },
    authz: { public: true } as const,
    spec: { endpoint: "manager3", owner: "u_op", clusterDigests: [D_IN] },
  };
  const m3Subj = (cmd: string, mode: "child" | "ledger") =>
    epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager3", command: cmd, caller, nonce: nonce(), target: { mode, tOwner: "u_abc" } });
  const m3Req = (cmd: string) =>
    req({ op: { endpoint: "manager3", command: cmd, inputDigest: D_IN, outputDigest: D_OUT }, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } });
  const srvNoSeam = serveEndpoint(nc, SPACE, { endpoint: "manager3", instanceId: IID_A, epoch: 1 }, m3Defs(), m3Describe, { resolveTarget });
  await nc.flush();
  const r11a = await send(m3Subj("adopt", "child"), m3Req("adopt"));
  c("a child-mode request with NO spawner seam is unavailable (fail closed, never the grant alone)",
    r11a !== undefined && r11a.reply.error?.code === "unavailable");
  const r11b = await send(m3Subj("audit", "ledger"), m3Req("audit"));
  c("a ledger-mode request with NO ledger seam is unavailable (fail closed)",
    r11b !== undefined && r11b.reply.error?.code === "unavailable");
  await srvNoSeam.stop();
  const srvSeamed = serveEndpoint(nc, SPACE, { endpoint: "manager3", instanceId: IID_A, epoch: 1 }, m3Defs(), m3Describe, {
    resolveTarget,
    childAuthority: (a) => { childCalls.push(a); if (childAnswer instanceof Error) throw childAnswer; return childAnswer; },
    ledgerAuthority: (a) => { ledgerCalls.push(a); return ledgerAnswer; },
  });
  await nc.flush();
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

  // describe: authorization-scoped answers off the broker-authenticated caller
  const dReq = req({ op: { endpoint: "manager", command: "describe" }, args: undefined });
  const r8 = await send(oneSubj("describe"), dReq);
  const answer = r8?.reply.data as DescribeAnswer | undefined;
  c("describe answers scoped: exactly the authorized command intersection",
    r8?.reply.ok === true && answer?.public === false
    && answer.descriptor.clusters.length === 2
    && JSON.stringify(answer.descriptor.clusters[0].commands) === JSON.stringify(["status"])
    && JSON.stringify(answer.descriptor.clusters[1].commands) === JSON.stringify(["badout", "cyclic"]));
  c("a PARTIAL cluster intersection omits the inline document (digest-only; no unauthorized leak)",
    answer !== undefined && answer.descriptor.clusters[0].document === undefined);
  c("a FULL cluster intersection keeps its inline document",
    answer !== undefined && answer.descriptor.clusters[1].document !== undefined);
  const r8b = await send(oneSubj("describe"), req({ op: { endpoint: "manager", command: "describe", inputDigest: D_IN, outputDigest: D_OUT }, args: undefined }));
  c("a digest carried on describe is contract-mismatch (nothing to honor)",
    r8b !== undefined && r8b.reply.error?.code === "contract-mismatch");
  const viewsBefore = viewCalls;
  const r8c = await send(oneSubj("describe"), req({ op: { endpoint: "manager", command: "describe" }, args: { name: "x" } }));
  c("describe with non-void args is bad-request BEFORE the authorization-view lookup",
    r8c !== undefined && r8c.reply.error?.code === "bad-request" && viewCalls === viewsBefore,
    JSON.stringify({ r: r8c?.reply, viewsBefore, viewCalls }));
  const r8d = await send(oneSubj("describe", { target: tgt }), req({ op: { endpoint: "manager", command: "describe" }, args: undefined, target: { owner: "u_abc", actor: "svc", lifecycleUid: T_UID } }));
  c("a TARGETED describe is permission-denied (reserved untargeted, SPEC 13.7)",
    r8d !== undefined && r8d.reply.error?.code === "permission-denied");

  // stop(): drains AND awaits in-flight handlers before reporting stopped
  gateArmed = true; // the next status handler parks until released
  nc.publish(epRequestSubject(SPACE, { route: { mode: "inst", instanceId: IID_A }, endpoint: "manager", command: "status", caller, nonce: nonce() }), new TextEncoder().encode(JSON.stringify(req())));
  await nc.flush();
  for (let i = 0; i < 60 && gate === undefined; i++) await wait(25); // the handler is parked once gate is set
  c("the gated handler is in flight", gate !== undefined);
  let stopped = false;
  const stopping = srvA.stop().then(() => { stopped = true; });
  await wait(400);
  c("stop() does NOT report stopped while a handler is in flight", stopped === false);
  gate!();
  await stopping;
  c("stop() resolves once the in-flight handler finishes", stopped === true);
  await srvB.stop();
  await wait(200);
  replies.length = 0; // the released handler still published its (valid) reply; clear it

  // an answerless trusted view fails CLOSED; a public descriptor consults no view
  const failDescriptor: DescribeDescriptor = { endpoint: "manager", owner: "u_op", protocol: { v: 1 }, clusters: [{ digest: D_IN, commands: ["status"] }] };
  const srvClosed = serveEndpoint(nc, SPACE, idA, [goodDef()], { descriptor: failDescriptor, authz: { view: () => undefined }, spec });
  await nc.flush();
  const r9 = await send(oneSubj("describe"), dReq);
  c("describe with no fresh trusted view is unavailable (fail closed, never a weaker source)",
    r9 !== undefined && r9.reply.ok === false && r9.reply.error?.code === "unavailable");
  await srvClosed.stop();
  const srvPub = serveEndpoint(nc, SPACE, idA, [goodDef()], { descriptor: failDescriptor, authz: { public: true }, spec });
  await nc.flush();
  const r10 = await send(oneSubj("describe"), dReq);
  const pub = r10?.reply.data as DescribeAnswer | undefined;
  c("a declared-public descriptor answers unscoped and SAYS it is public",
    pub?.public === true && pub.descriptor.clusters[0].commands.includes("status"));
  await srvPub.stop();

  await replySub.drain();
  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT SERVE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
