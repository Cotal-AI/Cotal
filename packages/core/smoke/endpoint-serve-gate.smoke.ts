/**
 * ENDPOINT-SERVE GATE smoke (control-surface P2 item 1, 1a-gate) — the FIRST production wiring of
 * the endpoint-serve credential subsystem (fact H3), proven over a REAL broker + real auth KV:
 * the endpoint issuance-gate lifecycle `epgate.<endpoint>.<instanceId>` and its `epcred.<…>` serve
 * ledger family, driven by the core primitives (`provisionEndpointGateOpen`,
 * `endpointRegistrationBarrier`, `serveIssuanceGateKv`) the auth session ledger and the manager
 * both share.
 *
 * Proves the panel's 1a-gate musts:
 *  - GATE-CAS TRAVERSAL, NO SEED SHORTCUT: the registration barrier observes -> freezes (open ->
 *    frozen under a registration op) -> reopens (frozen -> open at the successor generation). The
 *    gate is a real revision-pinned CAS; serve authority moves ONLY through it.
 *  - MINT FENCE: `serveIssuanceGateKv` stages an `epcred` row then commits a revision-pinned TOUCH;
 *    a mint whose observed revision was moved by a barrier LOSES (releases nothing).
 *  - REAL REVOKE PATH (not a stub): a takeover barrier enumerates the prior serve family and CASes
 *    every active row `active -> revoked`, so a superseded serve credential's ledger row is
 *    revoked and non-reissuable under the old generation.
 *  - LOSS NEGATIVES: freeze of a non-open gate loses; a stale-token reopen loses; a same-name
 *    re-provision with a DIFFERENT principal conflicts (an instance token is never re-bound).
 *
 * NOT in scope here (1a-serve): the `mintCreds(endpoint-serve)` -> `serveEndpoint` -> `epCall`
 * composition (a minted serve cred serving a real command) — that is where the MANAGER consumes
 * this subsystem; the serve/describe/invoke SURFACE is proven with fake gates in
 * endpoint-serve.smoke.ts. This smoke isolates the net-new real-KV credential LIFECYCLE.
 *
 * Run: pnpm smoke:ep-serve-gate   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError,
  createEndpointStreams,
  createSpaceAuth,
  newIdentity,
  mintCreds,
  credsClaims,
  credentialIdOf,
  DEV_OWNER,
  principalKey,
  compileContract,
  contractDigest,
  recordsBucket,
  registerServingInstance,
  epAuthBucket,
  epgateKey,
  epcredFamilyPrefix,
  epcredRowKey,
  walkKvLatest,
  markLedgerRowRevoked,
  commitSiblingIssuance,
  finalizeServeIssuance,
  parseEndpointGate,
  parseLedgerRow,
  mintLifecycleUid,
  provisionEndpointGateOpen,
  endpointRegistrationBarrier,
  serveIssuanceGateKv,
  type EpServeLedgerRow,
} from "../src/index.js";
import type { KV } from "@nats-io/kv";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();

const SPACE = "epservegate";
const ENDPOINT = "throwaway";
const IID = "i".repeat(26);
const PRINCIPAL = `u_${"c".repeat(26)}.term`; // the serving instance's CONNZ-attributable principal
const gateState = async (kv: KV) => parseEndpointGate((await kv.get(epgateKey(ENDPOINT, IID)))!.value, epgateKey(ENDPOINT, IID));
const gateRevision = async (kv: KV) => (await kv.get(epgateKey(ENDPOINT, IID)))!.revision;
const mkServeRow = (credentialId: string): EpServeLedgerRow => ({
  credentialId, credentialKey: "unused-by-fence", holderPrincipal: PRINCIPAL,
  endpoint: ENDPOINT, lifecycleUid: IID, sourceChain: ["session.abc"], state: "active", exp: 1_900_000_000,
  generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
});

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const kv = await new Kvm(nc).open(epAuthBucket(SPACE));

  console.log("A. provision the endpoint gate OPEN (the §13.1 pre-registration)");
  await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: IID, principal: PRINCIPAL });
  const born = await gateState(kv);
  c("the gate is born OPEN at generation 0, no op intent", born.state === "open" && born.generation === 0 && born.op === undefined, born);
  c("the gate carries the serving principal", born.principal === PRINCIPAL);
  await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: IID, principal: PRINCIPAL }); // idempotent
  c("re-provision with the SAME principal is idempotent (still open@gen0)", (await gateState(kv)).generation === 0);
  await rejects("re-provision with a DIFFERENT principal CONFLICTS (an instance token is never re-bound)",
    () => provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: IID, principal: `u_${"d".repeat(26)}.term` }), "conflict");

  console.log("B. the registration barrier: observe -> freeze -> reopen (the gate-CAS traversal, NO seed shortcut)");
  const op1 = mintLifecycleUid();
  const bar1 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op1 });
  const obs1 = await bar1.observe();
  c("observe reads the open gate at its revision", obs1 !== null && obs1.state === "open" && obs1.space === SPACE && obs1.endpoint === ENDPOINT && obs1.lifecycleUid === IID, obs1);
  const token1 = await bar1.freeze(obs1!.revision);
  c("freeze returns a fencing TOKEN and leaves the gate FROZEN under the registration op", token1 !== null && (await gateState(kv)).state === "frozen" && (await gateState(kv)).op?.opId === op1 && (await gateState(kv)).op?.kind === "registration", { token1 });
  c("a mint FENCE observes the gate FROZEN while a barrier holds it",
    (await serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID }).observe())!.state === "frozen");
  c("a mint commit while the gate is FROZEN LOSES (commit is open-only — no mint under a held barrier)",
    (await serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID }).commit(token1!)) === false);
  const reopened1 = await bar1.reopen(token1!, { generation: obs1!.generation + 1, processEpoch: obs1!.processEpoch, registrationRevision: 1, nameAuthorityRevision: obs1!.nameAuthorityRevision });
  const g1 = await gateState(kv);
  c("reopen advances the gate to OPEN at generation 1, op cleared, registrationRevision stamped", reopened1 === true && g1.state === "open" && g1.generation === 1 && g1.registrationRevision === 1 && g1.op === undefined, g1);

  console.log("C. the mint FENCE: stage an epcred row + commit a revision-pinned touch");
  const gate = serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID });
  const obsMint = await gate.observe();
  c("the mint observes the reopened open gate at gen1", obsMint !== null && obsMint.state === "open" && obsMint.generation === 1);
  const CRED_A = "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await gate.stage(mkServeRow(CRED_A));
  const stagedRow = parseLedgerRow((await kv.get(epcredRowKey(ENDPOINT, IID, CRED_A)))!.value, epcredRowKey(ENDPOINT, IID, CRED_A));
  c("stage writes an ACTIVE epcred ledger row for this instance, holder = the serving principal", stagedRow.state === "active" && stagedRow.holderPrincipal === PRINCIPAL && stagedRow.endpoint === ENDPOINT && stagedRow.lifecycleUid === IID, stagedRow);
  c("commit at the OBSERVED revision WINS (the mint released its credential)", (await gate.commit(obsMint!.revision)) === true);
  c("commit at a STALE revision LOSES (a barrier moved the gate since observation)", (await gate.commit(obsMint!.revision - 1)) === false);

  console.log("D. the REAL revoke path + FAIL-CLOSED default eviction on a takeover");
  // The DEFAULT (no injected evictor) must report NOT-verified on a non-empty family, so the saga's
  // `if (!evict) throw` leaves the gate frozen for reconciliation rather than reopening into
  // split-brain. It is ONLY ever consulted on a takeover (a fresh registration's family is empty).
  const barNoEvict = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: mintLifecycleUid() });
  c("the DEFAULT evictor is FAIL-CLOSED: no evictor ⇒ eviction NOT verified (a takeover fails closed, no silent split-brain)", (await barNoEvict.evict([PRINCIPAL]))[0] === false);
  // The happy takeover injects a REAL (here, test) evictor that verifies the predecessor GONE.
  let evicted: string | undefined;
  const op2 = mintLifecycleUid();
  const bar2 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op2, evict: (ps) => { [evicted] = ps; return ps.map(() => true); } });
  const obs2 = await bar2.observe();
  const token2 = await bar2.freeze(obs2!.revision);
  c("the takeover freeze wins the now-open gate", token2 !== null);
  const family = await bar2.enumerate();
  c("enumerate finds the prior ACTIVE epcred row (a REAL prefix scan, not an empty stub)", family.length === 1 && family[0].credentialId === CRED_A && family[0].state === "active" && family[0].holderPrincipal === PRINCIPAL, family);
  for (const row of family) if (row.state === "active") await bar2.revoke(row);
  const revoked = parseLedgerRow((await kv.get(epcredRowKey(ENDPOINT, IID, CRED_A)))!.value, epcredRowKey(ENDPOINT, IID, CRED_A));
  c("revoke CASes the prior serve credential's ledger row active -> REVOKED", revoked.state === "revoked", revoked);
  c("the INJECTED evictor verifies the predecessor principal GONE (real eviction is caller-supplied)", (await bar2.evict([PRINCIPAL]))[0] === true && evicted === PRINCIPAL);
  const reopened2 = await bar2.reopen(token2!, { generation: obs2!.generation + 1, processEpoch: obs2!.processEpoch, registrationRevision: 2, nameAuthorityRevision: obs2!.nameAuthorityRevision });
  c("the takeover reopens at generation 2 (the successor advanced past the revoked family)", reopened2 === true && (await gateState(kv)).generation === 2);
  c("re-enumerate now sees the row as REVOKED (non-reissuable under the old generation)", (await bar2.enumerate())[0].state === "revoked");

  console.log("E. loss negatives (fail-closed)");
  const op3 = mintLifecycleUid();
  const bar3 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op3 });
  const obs3 = await bar3.observe();
  const token3 = await bar3.freeze(obs3!.revision);
  c("freeze wins the open gate", token3 !== null);
  const op4 = mintLifecycleUid();
  const bar4 = endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: IID, opId: op4 });
  c("a SECOND freeze of the now-frozen gate LOSES (another barrier holds it)", (await bar4.freeze(await gateRevision(kv))) === null);
  c("a reopen with a STALE token LOSES (only the holder of the current freeze reopens)", (await bar3.reopen(token3! - 1, { generation: 99, processEpoch: 0, registrationRevision: 9, nameAuthorityRevision: 0 })) === false);
  c("the rightful holder still reopens at its token", (await bar3.reopen(token3!, { generation: obs3!.generation + 1, processEpoch: obs3!.processEpoch, registrationRevision: 3, nameAuthorityRevision: obs3!.nameAuthorityRevision })) === true);

  console.log("F. same-second serve retry, epoch-pinned takeover uniqueness, revoked-row conflict, and sibling issuance tags (#3856)");
  const recordsKv = await new Kvm(nc).open(recordsBucket(SPACE));
  const auth = await createSpaceAuth(SPACE);
  const contract = compileContract({ root: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false } });
  const doc = {
    urn: "ai.cotal.manager", revision: 1, attributes: [], events: [],
    commands: [{ name: "status", class: "ephemeral" as const, targeted: false, capability: "manager.call", inputDigest: contract.closureDigest, outputDigest: contract.closureDigest }],
  };
  const docRoot = contractDigest(doc);
  const manifest = { v: 1 as const, root: docRoot, members: [] as string[] };
  const dc = contractDigest(manifest);
  const artifacts = new Map<string, unknown>([[dc, manifest], [docRoot, doc]]);
  const readClusterArtifact = (d: string) => artifacts.get(d);
  const authority = { authorize: (name: string, owner: string) => ({ authorized: name === ENDPOINT && owner === DEV_OWNER, revision: 0 }) };
  const familyFor = async (iid: string) =>
    (await walkKvLatest(kv, `${epcredFamilyPrefix(ENDPOINT, iid)}.>`)).filter((e) => e.operation === "PUT").map((e) => parseLedgerRow(e.value, e.key));
  const alignToSecond = () => wait(1000 - (Date.now() % 1000) + 5);

  const serveId = newIdentity();
  const iidF = mintLifecycleUid();
  await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: iidF, principal: principalKey(DEV_OWNER, serveId.id).key });
  const reg1 = await registerServingInstance(recordsKv, {
    space: SPACE,
    spec: { endpoint: ENDPOINT, owner: DEV_OWNER, clusterDigests: [dc], protocol: { v: 1 } },
    instanceId: iidF,
    registrant: { owner: DEV_OWNER },
    authority,
    barrier: endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: iidF, opId: mintLifecycleUid() }),
    readClusterArtifact,
  });
  const fenceF = () => serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: iidF });

  let sameSecondServe: { a: string; b: string; iat: number; exp: number } | undefined;
  for (let attempt = 0; attempt < 10 && !sameSecondServe; attempt++) {
    await alignToSecond();
    const a = await mintCreds(auth, serveId, "endpoint-serve", { serveIssuance: fenceF(), endpointServe: reg1.grant });
    const b = await mintCreds(auth, serveId, "endpoint-serve", { serveIssuance: fenceF(), endpointServe: reg1.grant });
    const ca = credsClaims(a), cb = credsClaims(b);
    if (ca.iat !== undefined && ca.iat === cb.iat && ca.exp !== undefined && ca.exp === cb.exp)
      sameSecondServe = { a, b, iat: ca.iat, exp: ca.exp };
  }
  if (!sameSecondServe) throw new Error("could not land two endpoint-serve mints in one second");
  const rowsSameSec = await familyFor(iidF);
  c("two same-second endpoint-serve mints for the same nkey and epoch-pinned grant sign identical bytes and share credentialId",
    sameSecondServe.a === sameSecondServe.b && credentialIdOf(sameSecondServe.a) === credentialIdOf(sameSecondServe.b));
  c("same-second endpoint-serve re-mint at one epoch idempotently re-stages the single active epcred row and keeps the gate open",
    rowsSameSec.length === 1 && rowsSameSec[0].state === "active"
    && rowsSameSec[0].credentialId === credentialIdOf(sameSecondServe.a)
    && (await fenceF().observe())?.state === "open",
    rowsSameSec.map((r) => ({ id: r.credentialId, state: r.state })));

  // Later-second renewal for the same nkey and grant gets a fresh iat/exp and writes a second active row.
  while (Math.floor(Date.now() / 1000) <= sameSecondServe.iat) await wait(20);
  const laterCred = await mintCreds(auth, serveId, "endpoint-serve", { serveIssuance: fenceF(), endpointServe: reg1.grant });
  const rowsLater = await familyFor(iidF);
  c("a later-second endpoint-serve renewal for the same nkey and grant writes a distinct active epcred row",
    credsClaims(laterCred).iat! > sameSecondServe.iat
    && credentialIdOf(laterCred) !== credentialIdOf(sameSecondServe.a)
    && rowsLater.length === 2 && rowsLater.every((r) => r.state === "active"));

  // Takeover re-registration within the same Unix second: the epoch-pinned grant distinguishes the
  // successor credential from its revoked predecessor even when iat/exp and the nkey are identical.
  let sameSecondEpoch: { pred: string; succ: string; iid: string; succExp: number; grant: typeof reg1.grant } | undefined;
  for (let attempt = 0; attempt < 10 && !sameSecondEpoch; attempt++) {
    const iidE = mintLifecycleUid();
    await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId: iidE, principal: principalKey(DEV_OWNER, serveId.id).key });
    const rA = await registerServingInstance(recordsKv, {
      space: SPACE,
      spec: { endpoint: ENDPOINT, owner: DEV_OWNER, clusterDigests: [dc], protocol: { v: 1 } },
      instanceId: iidE,
      registrant: { owner: DEV_OWNER },
      authority,
      barrier: endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: iidE, opId: mintLifecycleUid() }),
      readClusterArtifact,
    });
    const fenceE = () => serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: iidE });
    await alignToSecond();
    const pred = await mintCreds(auth, serveId, "endpoint-serve", { serveIssuance: fenceE(), endpointServe: rA.grant });
    const rB = await registerServingInstance(recordsKv, {
      space: SPACE,
      spec: { endpoint: ENDPOINT, owner: DEV_OWNER, clusterDigests: [dc], protocol: { v: 1 } },
      instanceId: iidE,
      registrant: { owner: DEV_OWNER },
      authority,
      barrier: endpointRegistrationBarrier(kv, SPACE, { endpoint: ENDPOINT, instanceId: iidE, opId: mintLifecycleUid(), evict: (ps) => ps.map(() => true) }),
      readClusterArtifact,
    });
    const succ = await mintCreds(auth, serveId, "endpoint-serve", { serveIssuance: fenceE(), endpointServe: rB.grant });
    const cp = credsClaims(pred), cs = credsClaims(succ);
    if (cp.iat !== undefined && cp.iat === cs.iat && cp.exp !== undefined && cp.exp === cs.exp && rB.grant.epoch > rA.grant.epoch)
      sameSecondEpoch = { pred, succ, iid: iidE, succExp: cs.exp, grant: rB.grant };
  }
  if (!sameSecondEpoch) throw new Error("could not land predecessor and successor epoch serve mints in one second");
  const rowsEpoch = await familyFor(sameSecondEpoch.iid);
  c("the epoch-pinned serve grant gives a re-registered successor a distinct credentialId from its revoked predecessor within the same Unix second",
    credentialIdOf(sameSecondEpoch.succ) !== credentialIdOf(sameSecondEpoch.pred)
    && rowsEpoch.length === 2
    && rowsEpoch.find((r) => r.credentialId === credentialIdOf(sameSecondEpoch.pred))?.state === "revoked"
    && rowsEpoch.find((r) => r.credentialId === credentialIdOf(sameSecondEpoch.succ))?.state === "active");

  // Revoked-row resurrection refusal: if an epcred row is revoked, re-staging the same credentialId
  // conflicts and leaves the row revoked, never resurrecting it to active.
  const succId = credentialIdOf(sameSecondEpoch.succ);
  await markLedgerRowRevoked(kv, epcredRowKey(ENDPOINT, sameSecondEpoch.iid, succId));
  await rejects("re-staging a revoked serve credentialId CONFLICTS and never resurrects the revoked row",
    () => finalizeServeIssuance(
      serveIssuanceGateKv(kv, SPACE, { endpoint: ENDPOINT, instanceId: sameSecondEpoch.iid }),
      sameSecondEpoch.grant,
      { credentialId: succId, credentialKey: serveId.id, holderActor: serveId.id, sourceChain: ["root"], exp: sameSecondEpoch.succExp },
    ),
    "conflict");
  c("the conflicted row stays REVOKED after the refused re-stage",
    parseLedgerRow((await kv.get(epcredRowKey(ENDPOINT, sameSecondEpoch.iid, succId)))!.value, epcredRowKey(ENDPOINT, sameSecondEpoch.iid, succId)).state === "revoked");

  // Sibling controls: goal-writer and session-ledger carry no epoch-pinned grant, so userTags stamps
  // a random issuance: tag that makes two same-second mints for one nkey distinct.
  const gwId = newIdentity(), swId = newIdentity();
  let sameSecondSiblings: { g1: string; g2: string; s1: string; s2: string; exp: number } | undefined;
  for (let attempt = 0; attempt < 10 && !sameSecondSiblings; attempt++) {
    await alignToSecond();
    const g1 = await mintCreds(auth, gwId, "goal-writer", { goalWriter: { endpoint: ENDPOINT } });
    const g2 = await mintCreds(auth, gwId, "goal-writer", { goalWriter: { endpoint: ENDPOINT } });
    const s1 = await mintCreds(auth, swId, "session-ledger");
    const s2 = await mintCreds(auth, swId, "session-ledger");
    const cg1 = credsClaims(g1), cg2 = credsClaims(g2), cs1 = credsClaims(s1), cs2 = credsClaims(s2);
    if (cg1.iat !== undefined && cg1.iat === cg2.iat && cg1.iat === cs1.iat && cg1.iat === cs2.iat && cg1.exp !== undefined)
      sameSecondSiblings = { g1, g2, s1, s2, exp: cg1.exp };
  }
  if (!sameSecondSiblings) throw new Error("could not land same-second goal-writer and session-ledger mints");
  for (const [cred, id] of [
    [sameSecondSiblings.g1, gwId.id],
    [sameSecondSiblings.g2, gwId.id],
    [sameSecondSiblings.s1, swId.id],
    [sameSecondSiblings.s2, swId.id],
  ] as const) {
    const obs = (await fenceF().observe())!;
    await commitSiblingIssuance(fenceF(), obs, {
      credentialId: credentialIdOf(cred), credentialKey: id, holderPrincipal: principalKey(DEV_OWNER, id).key,
      endpoint: ENDPOINT, lifecycleUid: iidF, sourceChain: ["root"], state: "active", exp: sameSecondSiblings.exp,
      generation: obs.generation, processEpoch: obs.processEpoch,
      registrationRevision: obs.registrationRevision, nameAuthorityRevision: obs.nameAuthorityRevision,
    });
  }
  const rowsWithSiblings = await familyFor(iidF);
  c("two same-second goal-writer mints for one nkey get distinct credentialIds and stage two active epcred rows via userTags issuance:",
    credentialIdOf(sameSecondSiblings.g1) !== credentialIdOf(sameSecondSiblings.g2)
    && rowsWithSiblings.filter((r) => r.holderPrincipal === principalKey(DEV_OWNER, gwId.id).key && r.state === "active").length === 2);
  c("two same-second session-ledger mints for one nkey get distinct credentialIds and stage two active epcred rows via userTags issuance:",
    credentialIdOf(sameSecondSiblings.s1) !== credentialIdOf(sameSecondSiblings.s2)
    && rowsWithSiblings.filter((r) => r.holderPrincipal === principalKey(DEV_OWNER, swId.id).key && r.state === "active").length === 2);

  await nc.drain();
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

// Shipped source and compiled dist comments state the real uniqueness and retry mechanisms (#3856).
{
  const coreRoot = join(import.meta.dirname, "..");
  const repoRoot = join(coreRoot, "..", "..");
  const provisionSurfaces = [
    join(coreRoot, "src/provision.ts"),
    ...(existsSync(join(coreRoot, "dist/provision.js")) ? [join(coreRoot, "dist/provision.js")] : []),
  ].map((p) => readFileSync(p, "utf8"));
  const serviceSurfaces = [
    join(coreRoot, "src/endpoint-service.ts"),
    ...(existsSync(join(coreRoot, "dist/endpoint-service.d.ts")) ? [join(coreRoot, "dist/endpoint-service.d.ts")] : []),
  ].map((p) => readFileSync(p, "utf8"));
  const managerSurfaces = [
    join(repoRoot, "implementations/manager/src/manager.ts"),
    ...(existsSync(join(repoRoot, "implementations/manager/dist/manager.js")) ? [join(repoRoot, "implementations/manager/dist/manager.js")] : []),
  ].map((p) => readFileSync(p, "utf8"));

  c("provision.ts and dist/provision.js omit the false fresh exp/iat per-issuance uniqueness claim and name the epoch-pinned grant and same-second active retry",
    provisionSurfaces.every((t) =>
      !t.includes("has distinct bytes (fresh exp/iat)")
      && t.includes("epoch-pinned serve grant (`endpointServe.epoch` in the permission rows)")
      && t.includes("a same-second renewal")
      && t.includes("re-stages the same active row")));
  c("endpoint-service.ts and dist surfaces describe distinct JWTs (new epoch or later second) vs byte-identical same-second active retries",
    serviceSurfaces.every((t) =>
      !t.includes("Because `credentialId` is a per-JWT digest, a re-mint is a new id, never an overwrite.")
      && !t.includes("unique per JWT so a\n   *  standing renewal never overwrites the prior row.")
      && t.includes("byte-identical same-second re-mint at one")));
  c("manager.ts and dist/manager.js attribute goal-writer and session-ledger per-issuance uniqueness to the random issuance: tag in userTags",
    managerSurfaces.every((t) =>
      !t.includes("every renewal stages a distinct ledger")
      && t.includes("`mintCreds` stamps a random `issuance:` tag on `goal-writer` (`userTags`)")
      && t.includes("Because `mintCreds` stamps a random `issuance:` tag on")
      && t.includes("`session-ledger` (`userTags`)")));
}

console.log(`\n${fail === 0 ? "ENDPOINT-SERVE GATE SMOKE OK ✅" : "ENDPOINT-SERVE GATE SMOKE FAILED"}  (${ok} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
