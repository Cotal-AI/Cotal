/**
 * v0.4 serve-credential confinement smoke (SPEC §13.9 serve rows; the D4 half of the split
 * serve-cred/D14 gate) — a real JWT-auth broker proves the DEDICATED `endpoint-serve` profile
 * minted from an `authorizeServeGrant`-branded ARTIFACT:
 *   - minting is gated on registry authorization over VERIFIED cluster bytes: a raw value, a
 *     structural copy, an agent-profile fold, and foreign name/instance/command grants all
 *     REFUSE at the mint;
 *   - the mint context is BOUND and FRESH: a foreign space, a foreign principal, a stale
 *     (un-re-verified) artifact, a superseded epoch, and a re-registered instance all refuse —
 *     every successful mint rides its own fresh registry fence;
 *   - a registered instance serves and replies THROUGH the restricted credential on all three
 *     rails (one/all/inst) plus the DERIVED describe, and the positive serve connection is
 *     watched for async violations (none may occur);
 *   - class-rail admission is queue-qualified ONLY and queue-pinned, per registered
 *     endpoint + command; the profile carries NO agent baseline (chat denied);
 *   - another instance's rail, an unregistered command, and a foreign endpoint are DENIED;
 *   - egress (reply/epe/ept-schedule/epr) is epoch-pinned: the wrong epoch and the timer
 *     `.armed` phase are DENIED; the own epoch-pinned timer `.fire` READ is granted, any
 *     other instance's or epoch's is not;
 *   - an ordinary caller credential cannot subscribe the class rail, publish unminted rails,
 *     or forge the instance's epe/ept/epr egress;
 *   - the admin profile's god-view is the MESSAGING plane only: chat/inst/svc subscribe, the
 *     space-wide `>` and the ep request rails are DENIED.
 * The `$JS.API` bind rows (effects/pool durables) and the full cross-resource D32 audit remain
 * the recorded D14 gate.
 *
 * Run: pnpm smoke:ep-serve:auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, EpEnvelopeError,
  serveEndpoint, compileContract, contractDigest, registerServiceInstance, authorizeServeGrant,
  finalizeServeIssuance,
  epRequestSubject, epCallerReplyFilter, epServeFilter, epClassQueueGroup, spacePrefix,
  type EpCaller, type EndpointReply, type EpCommandDef,
  type DescribeAnswer, type ServiceNameAuthority, type EpServeGrant,
  type EpIssuanceGate, type EpIssuanceBarrier, type EpGateState, type EpServeLedgerRow,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rejects = async (n: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};

const PORT = 12000 + Math.floor(Math.random() * 8000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `epsauth${randomUUID().slice(0, 6).replace(/-/g, "")}`;
const IID = "a".repeat(26);
const IID_B = "b".repeat(26);
const EPOCH = 2;
const UID = "c".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-epsauth-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const contract = compileContract({ root: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false } });
const D = contract.closureDigest;
// The §13.7 cluster document: the digest-verified authority for the served surface. The store
// holds BOTH the manifest (at the closure digest) and the root document (at its artifact digest).
const DOC = {
  urn: "ai.cotal.manager", revision: 1, attributes: [], events: [],
  commands: [{ name: "status", class: "ephemeral", targeted: false, capability: "manager.call", inputDigest: D, outputDigest: D }],
};
const DOC_ROOT = contractDigest(DOC);
const DC = contractDigest({ v: 1, root: DOC_ROOT, members: [] });
const store = new Map<string, unknown>([[DC, { v: 1, root: DOC_ROOT, members: [] }], [DOC_ROOT, DOC]]);
const readClusterArtifact = (d: string) => store.get(d);
/** register-with-required-governance-policy: the registrar's governed-continuity policy is
 *  REQUIRED and closed for this revision, so every registration threads the canonical governed
 *  set + the store reader (these clusters declare no governed traits, so the endpoint governance
 *  head just stays empty). */
const regSvc = (kvArg: KV, a: Omit<Parameters<typeof registerServiceInstance>[1], "readClusterArtifact">) =>
  registerServiceInstance(kvArg, { ...a, readClusterArtifact });

/** In-process KV stub carrying the registration the PROVISIONER authorizes against — the
 *  broker's job in this smoke is enforcing the minted ROWS; the registry read itself is the
 *  provisioner's trusted seam (its broker-side grant is the D14 gate). */
function memKv(): KV {
  const store2 = new Map<string, { value: Uint8Array; revision: number; operation: "PUT" }>();
  let seq = 0;
  return {
    get: async (k: string) => store2.get(k),
    put: async (k: string, v: Uint8Array, o?: { previousSeq?: number }) => {
      if (o?.previousSeq === 0 && store2.has(k)) throw new Error(`wrong last sequence: ${k} exists`);
      store2.set(k, { value: v, revision: ++seq, operation: "PUT" });
      return seq;
    },
    update: async (k: string, v: Uint8Array, expected: number) => {
      if (store2.get(k)?.revision !== expected) throw new Error("wrong last sequence");
      store2.set(k, { value: v, revision: ++seq, operation: "PUT" });
      return seq;
    },
  } as unknown as KV;
}

/** A faithful in-memory model of the §13.1 durable issuance gate (`gate.<lifecycleUid>`): ONE key
 *  binding `{lifecycleUid, state, generation, processEpoch, registrationRevision,
 *  nameAuthorityRevision, revision}` with BOTH halves of the seam sharing it. The mint's `commit`
 *  and every barrier's `freeze` are revision-pinned CAS on the SAME key and each advances
 *  `revision`, so exactly one of a parked mint's commit and a barrier's freeze wins. `freeze`
 *  returns the FROZEN revision as a fencing token; `reopen(token, …)` is a CAS that only the
 *  barrier still holding its token can win (a stale reopen loses). `stage` is CREATE-ONLY /
 *  idempotent-if-identical (a different row for the same credentialId conflicts). `evict` models
 *  verified cluster-wide eviction (records the principal; a per-gate override forces fail-closed).
 *  The ledger `rows` carry the normative §13.1 fields + `active`/`revoked` state. */
function makeGate(init: { endpoint: string; lifecycleUid: string; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision?: number; evictOk?: boolean; space?: string }) {
  const gate = {
    space: init.space ?? space, // this smoke's single space; a per-gate override tests cross-space refusal
    endpoint: init.endpoint,
    lifecycleUid: init.lifecycleUid,
    state: "open" as "open" | "frozen" | "retired",
    generation: init.generation,
    processEpoch: init.processEpoch,
    registrationRevision: init.registrationRevision,
    nameAuthorityRevision: init.nameAuthorityRevision ?? 0,
    revision: 1,
  };
  const rows = new Map<string, EpServeLedgerRow>(); // keyed by credentialId; row.state is active|revoked
  const evicted: string[] = [];
  let evictOk = init.evictOk ?? true;
  const observe = (): EpGateState | null => ({ ...gate });
  const revoke = (row: EpServeLedgerRow) => { const e = rows.get(row.credentialId); if (e) e.state = "revoked"; };
  const seam: EpIssuanceGate = {
    observe,
    stage: (row) => {
      const existing = rows.get(row.credentialId);
      if (existing) { // create-only / idempotent-if-identical: a differing row for the same id conflicts
        if (JSON.stringify(existing) !== JSON.stringify(row)) throw new Error(`ledger row conflict: credentialId ${row.credentialId} already staged with a different value`);
        return;
      }
      rows.set(row.credentialId, { ...row });
    },
    commit: (expectedRevision) => {
      if (gate.state !== "open" || gate.revision !== expectedRevision) return false;
      gate.revision++; // a winning mint advances the gate revision, staying open at the same tuple
      return true;
    },
    revoke,
  };
  const barrier: EpIssuanceBarrier = {
    observe,
    freeze: (expectedRevision) => {
      if (gate.state !== "open" || gate.revision !== expectedRevision) return null; // revision-pinned CAS
      gate.state = "frozen"; gate.revision++;
      return gate.revision; // the fencing token = the frozen revision
    },
    enumerate: () => [...rows.values()],
    revoke,
    evict: (holderPrincipal) => { if (!evictOk) return false; evicted.push(holderPrincipal); return true; },
    reopen: (token, succ) => {
      if (gate.state !== "frozen" || gate.revision !== token) return false; // token-pinned CAS: a stale reopen loses
      gate.state = "open";
      gate.generation = succ.generation;
      gate.processEpoch = succ.processEpoch;
      gate.registrationRevision = succ.registrationRevision;
      gate.nameAuthorityRevision = succ.nameAuthorityRevision;
      gate.revision++;
      return true;
    },
  };
  return {
    seam, barrier, rows, evicted,
    /** CAS-freeze the gate at its CURRENT revision (a barrier's first step); returns the token or null. */
    freezeNow: () => barrier.freeze(gate.revision),
    retire: () => { gate.state = "retired"; gate.revision++; },
    setEvictOk: (v: boolean) => { evictOk = v; },
    coord: () => ({ ...gate }),
    active: () => [...rows.values()].filter((r) => r.state === "active").length,
    revoked: () => [...rows.values()].filter((r) => r.state === "revoked").length,
  };
}

/** Connect with `creds`, run `op`, and classify: any async permission/authorization violation
 *  (connection status or subscription callback) ⇒ "denied"; silence ⇒ "allowed". */
async function probe(creds: string, id: string, op: (nc: NatsConnection) => void | Promise<void>, graceMs = 500): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  let denied = false;
  void (async () => {
    for await (const s of nc.status()) {
      // The violation rides a {type:"error", error:{name:"PermissionViolationError"}} event.
      if (/permission|authorization/i.test(JSON.stringify(s))) denied = true;
    }
  })().catch(() => {});
  try {
    await op(nc);
    await nc.flush().catch(() => { denied = true; });
    await wait(graceMs);
  } finally {
    await nc.close().catch(() => {});
  }
  return denied ? "denied" : "allowed";
}

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(100); }
  if (!up) throw new Error("auth broker did not come up");

  // ---- authorize the serve artifact against the REGISTERED service ----
  const NAR = 0; // the name-authority binding revision the mock reports for "manager"
  const authority: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: NAR }) };
  const kv = memKv();
  const svcSpec = { endpoint: "manager", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
  // The provisioner-created gate (§13.1) the registration barrier writes behind: open, pre-registration.
  const regGate = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: NAR });
  const reg = await regSvc(kv, { space, spec: svcSpec, instanceId: IID, registrant: { owner: "u_op" }, authority, barrier: regGate.barrier });
  c("registration ran the barrier: it froze+reopened the gate at the new registrationRevision",
    regGate.coord().state === "open" && regGate.coord().registrationRevision === reg.registrationRevision && regGate.coord().generation === 1);
  const serveGrant = await authorizeServeGrant(kv, {
    space, endpoint: "manager", instanceId: IID, epoch: EPOCH,
    holder: { owner: "u_op" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact,
  });
  c("a registered instance's serve artifact authorizes for minting (verified full surface, bound space/owner, name-authority coordinate)",
    serveGrant.commands.length === 1 && serveGrant.commands[0] === "status" && serveGrant.space === space && serveGrant.owner === "u_op"
    && serveGrant.registrationRevision === reg.registrationRevision && serveGrant.nameAuthorityRevision === NAR);
  await rejects("a FOREIGN NAME cannot authorize a mintable serve artifact (holder is not the registered owner)",
    () => authorizeServeGrant(kv, { space, endpoint: "manager", instanceId: IID, epoch: EPOCH, holder: { owner: "u_evil" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact }), "permission-denied");
  await rejects("a FOREIGN INSTANCE cannot authorize (unregistered)",
    () => authorizeServeGrant(kv, { space, endpoint: "manager", instanceId: IID_B, epoch: EPOCH, holder: { owner: "u_op" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact }), "failed-precondition");

  // ---- the durable issuance gate is the mint fence (SPEC 13.1); it binds epoch + reg rev + name authority ----
  const gate = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
  const mintServe = (over: Record<string, unknown> = {}) => mintCreds(auth, newIdentity(), "endpoint-serve", {
    principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam, ...over,
  } as Parameters<typeof mintCreds>[3]);
  const mintThrows = async (opts: Parameters<typeof mintCreds>[3], profile: Parameters<typeof mintCreds>[2] = "endpoint-serve") => {
    try { await mintCreds(auth, newIdentity(), profile, opts); return false; } catch { return true; }
  };
  c("a RAW unbranded serve value refuses at the mint",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, endpointServe: { endpoint: "manager", instanceId: IID, epoch: EPOCH, commands: ["status"] } as EpServeGrant, serveIssuance: gate.seam }));
  c("a STRUCTURAL COPY of the authorized artifact refuses at the mint",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, endpointServe: { ...serveGrant } as EpServeGrant, serveIssuance: gate.seam }));
  c("the AGENT profile refuses serve rows (a serve credential is never an agent-baseline cred)",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam }, "agent"));
  c("NON-AGENT profiles refuse an extraneous serve artifact too (early-return arms must not silently ignore it)",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam }, "supervisor")
    && await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam }, "observer"));
  c("the endpoint-serve profile without an artifact refuses",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, serveIssuance: gate.seam }));
  c("the endpoint-serve profile without the issuance gate refuses (the release fence is mandatory)",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant }));

  // ---- mint the restricted profiles (each mint wins its own CAS on the open gate) ----
  const serveId = newIdentity();
  const serveCreds = await mintCreds(auth, serveId, "endpoint-serve", {
    principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam,
  });
  c("the mint STAGED its credential-ledger row and WON the gate CAS (one active row)",
    gate.active() === 1 && gate.revoked() === 0);
  c("the staged ledger row carries the NORMATIVE §13.1 fields (per-JWT credentialId + nkey credentialKey, holderPrincipal, lifecycleUid, ['root'] lineage, state, exp)",
    (() => { const r = [...gate.rows.values()][0]; return typeof r.credentialId === "string" && r.credentialId.startsWith("sha256-")
      && typeof r.credentialKey === "string" && r.credentialKey !== r.credentialId
      && r.holderPrincipal === "u_op.mgr" && r.lifecycleUid === IID
      && Array.isArray(r.sourceChain) && r.sourceChain.length === 1 && r.sourceChain[0] === "root" && r.state === "active" && typeof r.exp === "number"
      && r.registrationRevision === reg.registrationRevision && r.nameAuthorityRevision === NAR; })());
  c("a SECOND mint from the same artifact writes a DISTINCT per-JWT ledger row (renewal never overwrites)",
    (await mintServe()).includes("USER JWT") && gate.active() === 2 && new Set([...gate.rows.keys()]).size === 2);
  c("the issuance gate stage is create-only/idempotent (re-staging the SAME row keeps ONE row; a differing row for the same id conflicts)",
    (() => {
      const before = gate.rows.size; const r = [...gate.rows.values()][0];
      gate.seam.stage({ ...r }); // idempotent: identical row, no new entry
      let conflicted = false;
      try { gate.seam.stage({ ...r, holderPrincipal: "u_evil.x" }); } catch { conflicted = true; }
      return gate.rows.size === before && conflicted;
    })());

  // ---- D14: the §13.9:2473 bind rows ride the minted credential (journal class + owned pools) ----
  const decodeJwtRows = (creds: string): { pub: string[]; sub: string[] } => {
    const jwt = /BEGIN NATS USER JWT-+\s+(\S+)/.exec(creds)![1];
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const nats = (JSON.parse(Buffer.from(payload, "base64").toString()) as { nats: { pub: { allow: string[] }; sub: { allow: string[] } } }).nats;
    return { pub: nats.pub.allow, sub: nats.sub.allow };
  };
  {
    const ephRows = decodeJwtRows(serveCreds);
    c("an EPHEMERAL-ONLY poolless serve credential carries NO JetStream rows at all (default-deny both directions)",
      ephRows.pub.every((r) => !r.startsWith("$JS.")));
    const DOC_J = {
      urn: "ai.cotal.jobsrv", revision: 1, attributes: [], events: [],
      commands: [{ name: "submitjob", class: "journal", targeted: false, capability: "jobsrv.call", inputDigest: D, outputDigest: D }],
    };
    const DOCJ_ROOT = contractDigest(DOC_J);
    const DCJ = contractDigest({ v: 1, root: DOCJ_ROOT, members: [] });
    store.set(DCJ, { v: 1, root: DOCJ_ROOT, members: [] });
    store.set(DOCJ_ROOT, DOC_J);
    const jRegGate = makeGate({ endpoint: "jobsrv", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: NAR });
    const jReg = await regSvc(kv, { space, spec: { endpoint: "jobsrv", owner: "u_op", clusterDigests: [DCJ], protocol: { v: 1 } }, instanceId: IID, registrant: { owner: "u_op" }, authority, barrier: jRegGate.barrier });
    const jGrant = await authorizeServeGrant(kv, {
      space, endpoint: "jobsrv", instanceId: IID, epoch: EPOCH,
      holder: { owner: "u_op" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact, pools: ["pb", "pa"],
    });
    const jMintGate = makeGate({ endpoint: "jobsrv", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: jReg.registrationRevision, nameAuthorityRevision: NAR });
    const jRows = decodeJwtRows(await mintCreds(auth, newIdentity(), "endpoint-serve", {
      principal: { owner: "u_op", actor: "job" }, endpointServe: jGrant, serveIssuance: jMintGate.seam,
    }));
    const has = (r: string) => jRows.pub.includes(r);
    c("a JOURNAL+POOLS serve credential carries EXACTLY the bind rows: the shared effects durable + each owned pool + one $JS.API.INFO, all name-literal, bind-only",
      has(`$JS.API.CONSUMER.INFO.EPF_${space}.eff_jobsrv`) && has(`$JS.API.CONSUMER.MSG.NEXT.EPF_${space}.eff_jobsrv`) && has(`$JS.ACK.EPF_${space}.eff_jobsrv.>`)
      && has(`$JS.API.CONSUMER.INFO.EPW_${space}.pool_jobsrv_pa`) && has(`$JS.API.CONSUMER.MSG.NEXT.EPW_${space}.pool_jobsrv_pa`) && has(`$JS.ACK.EPW_${space}.pool_jobsrv_pa.>`)
      && has(`$JS.API.CONSUMER.INFO.EPW_${space}.pool_jobsrv_pb`) && has(`$JS.API.CONSUMER.MSG.NEXT.EPW_${space}.pool_jobsrv_pb`) && has(`$JS.ACK.EPW_${space}.pool_jobsrv_pb.>`)
      && has("$JS.API.INFO")
      && jRows.pub.filter((r) => r.startsWith("$JS.")).length === 10
      && !jRows.pub.some((r) => r.includes("CONSUMER.CREATE") || r.includes("CONSUMER.DELETE") || r.includes("STREAM.")));
  }

  // ---- mint context binding (space + principal) ----
  await rejects("a FOREIGN PRINCIPAL cannot mint from the artifact (the minted principal IS the registered owner)",
    () => mintServe({ principal: { owner: "u_evil", actor: "mgr" } }), "permission-denied");
  {
    const foreign = await createSpaceAuth("foreignspace");
    await rejects("a CROSS-SPACE mint refuses (the artifact binds its space)",
      () => mintCreds(foreign, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam }), "permission-denied");
  }

  // ---- the durable fence: the three currency dimensions + missing/retired gates (SPEC 13.1) ----
  // A gate whose epoch / reg-rev / name-authority-rev has already advanced past the artifact's is
  // `expired` at observe; the mint never reaches the CAS.
  {
    const drifted = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 2, processEpoch: EPOCH + 1, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    await rejects("EPOCH DRIFT: the gate is at a newer processEpoch than the artifact; mint refuses, releases nothing",
      () => mintServe({ serveIssuance: drifted.seam }), "expired");
    c("…and the drifted mint staged NO surviving row (it never reached the CAS)", drifted.active() === 0 && drifted.revoked() === 0);
  }
  {
    const reReg = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision + 1, nameAuthorityRevision: NAR });
    await rejects("RE-REGISTRATION DRIFT: the gate is at a newer registrationRevision; mint refuses (superseded surface)",
      () => mintServe({ serveIssuance: reReg.seam }), "expired");
  }
  {
    const nameDrift = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR + 1 });
    await rejects("NAME-AUTHORITY DRIFT: the gate is at a newer nameAuthorityRevision; mint refuses (a name transfer superseded the owner)",
      () => mintServe({ serveIssuance: nameDrift.seam }), "expired");
  }
  {
    const missing: EpIssuanceGate = { observe: () => null, stage: () => { throw new Error("unreached"); }, commit: () => { throw new Error("unreached"); }, revoke: () => {} };
    await rejects("a MISSING (null) gate refuses the mint (a serve cred never mints against a missing gate)",
      () => mintServe({ serveIssuance: missing }), "expired");
    const retired = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    retired.retire();
    await rejects("a RETIRED gate refuses the mint (minting is closed for the lifecycle)",
      () => mintServe({ serveIssuance: retired.seam }), "expired");
  }
  {
    const frozenGate = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    c("a barrier's freeze is a revision-pinned CAS (the WRONG expected revision returns null, no token)", frozenGate.barrier.freeze(999) === null);
    c("…and the barrier's freeze at the CURRENT revision returns a fencing token", typeof frozenGate.freezeNow() === "number");
    await rejects("a FROZEN gate refuses the mint (a barrier won the single-key serialization)",
      () => mintServe({ serveIssuance: frozenGate.seam }), "expired");
  }
  // Parked-mint-vs-barrier: the mint observes an OPEN gate, then a barrier CAS-freezes it (the
  // revision advances) before the mint's revision-pinned commit. The CAS loses, the staged row is
  // revoked, and NO credential is released. This is the mint-loses side of the single-key race.
  {
    const raceGate = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    let barrierWon = false;
    const racing: EpIssuanceGate = {
      observe: raceGate.seam.observe,
      stage: (row) => { raceGate.seam.stage(row); barrierWon = raceGate.freezeNow() !== null; }, // barrier freezes between stage and commit
      commit: raceGate.seam.commit,
      revoke: raceGate.seam.revoke,
    };
    let released = "";
    try { released = await mintCreds(auth, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: racing }); } catch { /* expected */ }
    c("parked-mint-vs-barrier: the barrier's freeze wins the CAS, the mint releases NOTHING and revokes its staged row",
      barrierWon && released === "" && raceGate.active() === 0 && raceGate.revoked() === 1);
  }
  // Mint-WINS-then-barrier-enumerates-and-evicts: the mint commits its row (active), THEN a
  // barrier freezes, enumerates the family, revokes the released credential by holderPrincipal,
  // and reopens at the successor coordinate. This is the eviction half the §13.1 ledger exists for.
  {
    const g = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    await finalizeServeIssuance(g.seam, serveGrant, { credentialId: "sha256:" + "a".repeat(64), credentialKey: newIdentity().id, holderActor: "mgr", sourceChain: ["root"], exp: 111 });
    c("a mint that wins the CAS on an open, current gate commits its row (the positive fence path)",
      g.active() === 1 && g.revoked() === 0);
    const before = g.coord();
    const token = g.freezeNow();
    if (token === null) throw new Error("barrier freeze should win");
    const family = g.barrier.enumerate();
    for (const row of family) if (row.state === "active") g.barrier.revoke(row);
    for (const p of new Set(family.filter((r) => r.state === "revoked").map((r) => r.holderPrincipal)))
      if (!g.barrier.evict(p)) throw new Error("evict should verify gone");
    const reopened = g.barrier.reopen(token, { generation: before.generation + 1, processEpoch: before.processEpoch, registrationRevision: before.registrationRevision + 1, nameAuthorityRevision: before.nameAuthorityRevision });
    c("mint-wins→barrier enumerates→revokes→VERIFIED-evicts the released credential by holderPrincipal",
      family.length === 1 && family[0].holderPrincipal === "u_op.mgr" && g.active() === 0 && g.revoked() === 1 && g.evicted.includes("u_op.mgr"));
    c("…and the TOKEN-pinned reopen advanced the gate to the successor registrationRevision (a superseded re-mint would now lose)",
      reopened === true && g.coord().state === "open" && g.coord().registrationRevision === before.registrationRevision + 1);
  }
  // The REAL re-registration writer participates in the SAME gate (distsys/security finding 1):
  // register → mint (active) → re-register through registerServiceInstance (which freezes,
  // evicts, reopens) → the released credential is revoked and the pre-re-registration artifact
  // can no longer mint. No hand-driven barrier: the exported writer does it.
  {
    const kv2 = memKv();
    const authority2: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: 0 }) };
    const spec2 = { endpoint: "reg2", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
    const g = makeGate({ endpoint: "reg2", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    const r1 = await regSvc(kv2, { space, spec: spec2, instanceId: IID, registrant: { owner: "u_op" }, authority: authority2, barrier: g.barrier });
    const grant2 = await authorizeServeGrant(kv2, { space, endpoint: "reg2", instanceId: IID, epoch: EPOCH, holder: { owner: "u_op" }, authority: authority2, readProcessEpoch: () => EPOCH, readClusterArtifact });
    await mintCreds(auth, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: grant2, serveIssuance: g.seam });
    c("a serve credential minted against the current registration is ACTIVE on the gate", g.active() === 1 && g.revoked() === 0);
    const r2 = await regSvc(kv2, { space, spec: spec2, instanceId: IID, registrant: { owner: "u_op" }, authority: authority2, barrier: g.barrier });
    c("re-registration through the REAL writer revoked + VERIFIED-evicted the superseded credential and advanced the gate",
      g.active() === 0 && g.revoked() === 1 && g.evicted.includes("u_op.mgr") && g.coord().registrationRevision === r2.registrationRevision && r2.registrationRevision > r1.registrationRevision);
    await rejects("STALE-SURFACE probe closed: a mint from the pre-re-registration artifact now refuses (registrationRevision advanced)",
      () => mintCreds(auth, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: grant2, serveIssuance: g.seam }), "expired");
  }
  // registerServiceInstance barrier BRANCHES: a registration never proceeds on a null/frozen/
  // retired gate or a lost freeze, and an aborted registration restores the gate to OPEN at its
  // ORIGINAL coordinate (so a mid-flight mint's revision pin still loses, never a stuck-frozen gate).
  {
    const kv3 = memKv();
    const auth3: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: 0 }) };
    const spec3 = { endpoint: "reg3", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
    const nullBarrier: EpIssuanceBarrier = { observe: () => null, freeze: () => { throw new Error("unreached"); }, enumerate: () => [], revoke: () => {}, evict: () => { throw new Error("unreached"); }, reopen: () => { throw new Error("unreached"); } };
    await rejects("registration against a MISSING gate refuses failed-precondition (the provisioner creates the gate)",
      () => regSvc(kv3, { space, spec: spec3, instanceId: IID, registrant: { owner: "u_op" }, authority: auth3, barrier: nullBarrier }), "failed-precondition");
    const gfrozen = makeGate({ endpoint: "reg3", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    gfrozen.freezeNow();
    await rejects("registration against a FROZEN gate refuses conflict (another barrier holds the key)",
      () => regSvc(kv3, { space, spec: spec3, instanceId: IID, registrant: { owner: "u_op" }, authority: auth3, barrier: gfrozen.barrier }), "conflict");
    const gretired = makeGate({ endpoint: "reg3", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    gretired.retire();
    await rejects("registration against a RETIRED gate refuses failed-precondition (permanently closed, a re-read cannot help)",
      () => regSvc(kv3, { space, spec: spec3, instanceId: IID, registrant: { owner: "u_op" }, authority: auth3, barrier: gretired.barrier }), "failed-precondition");
    const glost = makeGate({ endpoint: "reg3", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    const lostBarrier: EpIssuanceBarrier = { ...glost.barrier, freeze: () => null };
    await rejects("registration whose freeze LOSES the CAS refuses conflict (a concurrent barrier won the key)",
      () => regSvc(kv3, { space, spec: spec3, instanceId: IID, registrant: { owner: "u_op" }, authority: auth3, barrier: lostBarrier }), "conflict");
    // cross-space registration refusal (mirror the mint-side crossSpace probe): the `(space, endpoint,
    // instanceId)` gate-identity check is not mint-only - a gate constructed for ANOTHER space refuses a
    // registration too, so a composition mixup can't drive a space-A registration through a space-B gate.
    const gCrossSpace = makeGate({ space: "otherspace", endpoint: "reg3", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    await rejects("registration against a gate for ANOTHER space refuses internal (full (space, endpoint, instance) identity, §13.1)",
      () => regSvc(kv3, { space, spec: spec3, instanceId: IID, registrant: { owner: "u_op" }, authority: auth3, barrier: gCrossSpace.barrier }), "internal");
    // abort path: a re-registration that fails ownership stability AFTER the freeze must reopen.
    const authAcme: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_acme", revision: 0 }) };
    const specAcme = { endpoint: "com.acme.reg", owner: "u_acme", clusterDigests: [DC], protocol: { v: 1 as const } };
    const gabort = makeGate({ endpoint: "com.acme.reg", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    await regSvc(kv3, { space, spec: specAcme, instanceId: IID, registrant: { owner: "u_acme" }, authority: authAcme, barrier: gabort.barrier });
    const openCoord = gabort.coord();
    const authEvil: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_evil", revision: 0 }) };
    await rejects("a re-registration changing ownership is rejected AFTER the freeze (ownership stability)",
      () => regSvc(kv3, { space, spec: { ...specAcme, owner: "u_evil" }, instanceId: IID, registrant: { owner: "u_evil" }, authority: authEvil, barrier: gabort.barrier }), "permission-denied");
    const afterAbort = gabort.coord();
    c("the aborted registration restored the gate to OPEN at the ORIGINAL coordinate (freeze happened, reopen-on-abort ran, revision advanced)",
      afterAbort.state === "open" && afterAbort.registrationRevision === openCoord.registrationRevision
      && afterAbort.generation === openCoord.generation + 1 && afterAbort.revision > openCoord.revision);
  }
  // GATE IDENTITY `(endpoint, lifecycleUid)`: a gate for a DIFFERENT instance token, OR the SAME
  // instance token under a DIFFERENT endpoint (the token is unique only within (space, endpoint),
  // distsys CROSS_ENDPOINT_GATE_ALIAS), is refused — a serve credential mints only against its OWN
  // gate (§13.1). serveGrant is for manager/IID.
  {
    const wrongInstance = makeGate({ endpoint: "manager", lifecycleUid: IID_B, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    await rejects("a gate for a DIFFERENT instance token refuses the mint (gate identity binding, §13.1)",
      () => mintServe({ serveIssuance: wrongInstance.seam }), "internal");
    const crossEndpoint = makeGate({ endpoint: "delivery", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    await rejects("a gate for the SAME instance token under a DIFFERENT endpoint refuses (the token is unique only within (space, endpoint), §13.1)",
      () => mintServe({ serveIssuance: crossEndpoint.seam }), "internal");
    // Defense-in-depth (the per-space auth KV is the production boundary): a gate constructed for
    // ANOTHER space is refused too, so a composition mixup can't release space-A authority through
    // a space-B gate.
    const crossSpace = makeGate({ space: "otherspace", endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    await rejects("a gate constructed for ANOTHER space refuses the mint (full (space, endpoint, instance) identity, §13.1)",
      () => mintServe({ serveIssuance: crossSpace.seam }), "internal");
  }
  // REOPEN is TOKEN-pinned: only the completing barrier (holding its freeze token) reopens; a
  // stale/duplicate reopen with the same token loses and never clobbers the newer gate.
  {
    const g = makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: 5, nameAuthorityRevision: NAR });
    const token = g.freezeNow();
    if (token === null) throw new Error("freeze should win");
    const first = g.barrier.reopen(token, { generation: 2, processEpoch: EPOCH, registrationRevision: 6, nameAuthorityRevision: NAR });
    const stale = g.barrier.reopen(token, { generation: 99, processEpoch: EPOCH, registrationRevision: 999, nameAuthorityRevision: NAR });
    c("reopen is token-pinned: the completing reopen wins, a STALE reopen with the same token loses and leaves the newer gate intact",
      first === true && stale === false && g.coord().registrationRevision === 6);
  }
  // AMBIGUOUS spec write (committed then ack lost): the gate is left FROZEN for reconciliation,
  // never reopened at the old coordinate (which would permit a stale-surface release).
  {
    const backing = new Map<string, { value: Uint8Array; revision: number; operation: "PUT" }>();
    let seq = 0;
    const flakyKv = {
      get: async (k: string) => backing.get(k),
      put: async (k: string, v: Uint8Array) => {
        backing.set(k, { value: v, revision: ++seq, operation: "PUT" });
        if (k.startsWith("govern.")) return seq; // the governance slot-take commits cleanly first
        throw new Error("ack lost after the write committed"); // the SPEC write is the ambiguous one
      },
      update: async () => { throw new Error("unreached"); },
    } as unknown as KV;
    const auth4: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: 0 }) };
    const spec4 = { endpoint: "reg4", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
    const g = makeGate({ endpoint: "reg4", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    await rejects("an AMBIGUOUS spec-write (committed then ack lost) is unavailable, never a definite no-write",
      () => regSvc(flakyKv, { space, spec: spec4, instanceId: IID, registrant: { owner: "u_op" }, authority: auth4, barrier: g.barrier }), "unavailable");
    c("…and the gate is left FROZEN for reconciliation (never reopened at the old coordinate → no stale-surface release)", g.coord().state === "frozen");
  }
  // VERIFIED EVICTION is fail-closed: a re-registration whose cluster-wide eviction cannot be
  // verified leaves the gate frozen, no new spec published (old authority never published-over).
  {
    const kv5 = memKv();
    const auth5: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: 0 }) };
    const spec5 = { endpoint: "reg5", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
    const g = makeGate({ endpoint: "reg5", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    await regSvc(kv5, { space, spec: spec5, instanceId: IID, registrant: { owner: "u_op" }, authority: auth5, barrier: g.barrier });
    const grant5 = await authorizeServeGrant(kv5, { space, endpoint: "reg5", instanceId: IID, epoch: EPOCH, holder: { owner: "u_op" }, authority: auth5, readProcessEpoch: () => EPOCH, readClusterArtifact });
    await mintCreds(auth, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: grant5, serveIssuance: g.seam });
    const rrBefore = g.coord().registrationRevision;
    g.setEvictOk(false); // cluster-wide eviction cannot be verified gone
    await rejects("re-registration whose VERIFIED EVICTION fails leaves the gate frozen, no new spec (fail-closed, §13.1)",
      () => regSvc(kv5, { space, spec: spec5, instanceId: IID, registrant: { owner: "u_op" }, authority: auth5, barrier: g.barrier }), "unavailable");
    c("…and the gate stayed FROZEN at the OLD registrationRevision (old authority is never published-over)",
      g.coord().state === "frozen" && g.coord().registrationRevision === rrBefore);
  }
  // REGISTRATION name-authority drift: the name-authority decision is made UNDER the frozen gate,
  // and the authorized revision must equal the frozen gate's nameAuthorityRevision. If a transfer
  // advanced the gate past the revision the owner is authorized at, registration refuses (conflict)
  // rather than writing a spec for a name the owner may no longer hold (engineer's 42feb0d residual).
  {
    const kv7 = memKv();
    const auth7: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: 3 }) }; // owner authorized at revision 3
    const spec7 = { endpoint: "reg7", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
    const g = makeGate({ endpoint: "reg7", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 4 }); // a completed transfer left the gate at 4
    await rejects("registration refuses when the frozen gate's nameAuthorityRevision drifted past the authority's (a transfer raced the registration writer)",
      () => regSvc(kv7, { space, spec: spec7, instanceId: IID, registrant: { owner: "u_op" }, authority: auth7, barrier: g.barrier }), "conflict");
    c("…and the racy registration wrote nothing: the gate reopened at its ORIGINAL coordinate",
      g.coord().state === "open" && g.coord().nameAuthorityRevision === 4 && g.coord().registrationRevision === 0);
  }
  // FULL-FAMILY eviction: an ALREADY-revoked row (a leftover from a prior partially-failed barrier)
  // whose connection may still be live must ALSO be verified-evicted, not skipped (§13.1). A
  // re-registration verified-evicts the distinct principals of the ENTIRE enumerated family.
  {
    const kv8 = memKv();
    const auth8: ServiceNameAuthority = { authorize: (_n, o) => ({ authorized: o === "u_op", revision: 0 }) };
    const spec8 = { endpoint: "reg8", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
    const g = makeGate({ endpoint: "reg8", lifecycleUid: IID, generation: 0, processEpoch: EPOCH, registrationRevision: 0, nameAuthorityRevision: 0 });
    await regSvc(kv8, { space, spec: spec8, instanceId: IID, registrant: { owner: "u_op" }, authority: auth8, barrier: g.barrier });
    const grant8 = await authorizeServeGrant(kv8, { space, endpoint: "reg8", instanceId: IID, epoch: EPOCH, holder: { owner: "u_op" }, authority: auth8, readProcessEpoch: () => EPOCH, readClusterArtifact });
    await mintCreds(auth, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: grant8, serveIssuance: g.seam }); // active row: u_op.mgr
    const co = g.coord();
    g.seam.stage({ credentialId: "sha256:" + "b".repeat(64), credentialKey: newIdentity().id, holderPrincipal: "u_op.old", endpoint: "reg8", lifecycleUid: IID, sourceChain: ["root"], state: "revoked", generation: co.generation, processEpoch: EPOCH, registrationRevision: co.registrationRevision, nameAuthorityRevision: 0 }); // already-revoked leftover
    await regSvc(kv8, { space, spec: spec8, instanceId: IID, registrant: { owner: "u_op" }, authority: auth8, barrier: g.barrier });
    c("re-registration verified-evicts the distinct principals of the FULL family, including an ALREADY-revoked row's principal (a partial-barrier leftover)",
      g.evicted.includes("u_op.mgr") && g.evicted.includes("u_op.old"));
  }
  // SOURCE-CHAIN grammar (§13.2:1248 id bound {1,64}): the exported finalizeServeIssuance refuses a
  // malformed §13.1 issuance lineage BEFORE observe/stage, so a bad chain never enters the ledger.
  {
    const freshGate = () => makeGate({ endpoint: "manager", lifecycleUid: IID, generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision, nameAuthorityRevision: NAR });
    const finalizeWith = (g: ReturnType<typeof makeGate>, chain: string[]) =>
      finalizeServeIssuance(g.seam, serveGrant, { credentialId: "sha256:" + "c".repeat(64), credentialKey: newIdentity().id, holderActor: "mgr", sourceChain: chain });
    await rejects("sourceChain [owner, actor] refuses (principal components are not a §13.1 lineage)", () => finalizeWith(freshGate(), ["u_op", "mgr"]), "internal");
    await rejects("sourceChain ['handle.x'] refuses (a handle step needs .<issuer>.<id>)", () => finalizeWith(freshGate(), ["handle.x"]), "internal");
    await rejects("sourceChain ['handle.x.'] refuses (empty second segment)", () => finalizeWith(freshGate(), ["handle.x."]), "internal");
    await rejects("sourceChain ['session.x.y'] refuses (a session step is one segment)", () => finalizeWith(freshGate(), ["session.x.y"]), "internal");
    await rejects("sourceChain with a 65-char id refuses (the id bound is {1,64}, SPEC 13.2)", () => finalizeWith(freshGate(), ["session." + "A".repeat(65)]), "internal");
    await rejects("an EMPTY sourceChain refuses (a lineage is non-empty)", () => finalizeWith(freshGate(), []), "internal");
    const accepts = async (chain: string[]) => { const g = freshGate(); let threw = false; try { await finalizeWith(g, chain); } catch { threw = true; } return !threw && g.active() === 1; };
    c("sourceChain ['root'] is accepted (root serve mint)", await accepts(["root"]));
    c("sourceChain ['handle.<issuer>.<id>'] with UPPERCASE record-grammar ids is accepted", await accepts(["handle.Issuer_1.Id-2"]));
    c("sourceChain ['session.<sessionId>'] with a 64-char id is accepted", await accepts(["session." + "S".repeat(64)]));
  }

  const callerId = newIdentity();
  const callerCreds = await mintCreds(auth, callerId, "agent", {
    principal: { owner: "u_abc", actor: "worker" },
    lifecycleUid: UID,
    endpointCapabilities: [
      { endpoint: "manager", command: "status", routes: ["one", "all"], instanceId: IID },
      { endpoint: "manager", command: "describe", routes: ["one"] },
    ],
  });

  // ---- POSITIVE: the instance serves and the caller calls, both through restricted creds.
  // The serve connection is WATCHED: a granted-rows serve loop must produce zero async
  // permission violations (a silent denial here would fake the positive path).
  const serveViolations: string[] = [];
  const serveNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(serveCreds)),
    inboxPrefix: `_INBOX_${serveId.id}`,
  });
  void (async () => {
    for await (const s of serveNc.status()) {
      if (/permission|authorization/i.test(JSON.stringify(s))) serveViolations.push(JSON.stringify(s));
    }
  })().catch(() => {});
  const statusDef: EpCommandDef = {
    command: "status",
    contract: { input: contract, output: contract },
    handler: () => ({ n: 1 }),
  };
  const handle = serveEndpoint(serveNc, space, serveGrant, [statusDef], { public: true });
  await serveNc.flush();

  const callerNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(callerCreds)),
    inboxPrefix: `_INBOX_${callerId.id}`,
  });
  const replies: EndpointReply[] = [];
  callerNc.subscribe(epCallerReplyFilter(space, caller), {
    callback: (_e, m) => { replies.push(JSON.parse(new TextDecoder().decode(m.data)) as EndpointReply); },
  });
  await callerNc.flush();
  let nonceN = 0;
  const nonce = () => `n${String(nonceN++).padStart(23, "0")}`;
  const statusReq = () => JSON.stringify({
    v: 1, id: "req-1", op: { endpoint: "manager", command: "status", inputDigest: D, outputDigest: D },
    class: "ephemeral", replyExpected: true, deadlineMs: 2000, args: { n: 7 }, from: { id: "u_abc.worker", name: "w" },
  });
  const call = async (subject: string, body: string) => {
    callerNc.publish(subject, new TextEncoder().encode(body));
    await callerNc.flush();
    for (let i = 0; i < 40 && replies.length === 0; i++) await wait(50);
    return replies.shift();
  };
  const rOne = await call(epRequestSubject(space, { route: { mode: "one" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), statusReq());
  c("the restricted serve credential answers the ONE rail through the restricted caller",
    rOne?.ok === true && (rOne.data as { n: number }).n === 1, JSON.stringify(rOne));
  const rInst = await call(epRequestSubject(space, { route: { mode: "inst", instanceId: IID }, endpoint: "manager", command: "status", caller, nonce: nonce() }), statusReq());
  c("the INSTANCE rail serves through the instance-pinned grant pair",
    rInst?.ok === true, JSON.stringify(rInst));
  const rAll = await call(epRequestSubject(space, { route: { mode: "all" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), statusReq());
  c("the SCATTER rail serves through the plain per-command grant",
    rAll?.ok === true, JSON.stringify(rAll));
  const rDesc = await call(epRequestSubject(space, { route: { mode: "one" }, endpoint: "manager", command: "describe", caller, nonce: nonce() }),
    JSON.stringify({ v: 1, id: "req-d", op: { endpoint: "manager", command: "describe" }, class: "ephemeral", replyExpected: true, deadlineMs: 2000, from: { id: "u_abc.worker", name: "w" } }));
  c("the DERIVED describe grant serves without ever being minted explicitly",
    rDesc?.ok === true && (rDesc.data as DescribeAnswer).public === true
    && (rDesc.data as DescribeAnswer).descriptor.clusters[0].commands.includes("status"),
    JSON.stringify(rDesc));
  await handle.stop();
  await wait(200);
  c("the positive serve connection observed ZERO async permission violations",
    serveViolations.length === 0, serveViolations[0]);
  await serveNc.close();
  await callerNc.close();

  // ---- DENY: class-rail admission ----
  const p = spacePrefix(space);
  const q = epClassQueueGroup("manager");
  c("serve cred: PLAIN class-rail subscribe is denied (queue-qualified only, §13.9)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(epServeFilter(space, "one", "manager"), { callback: () => {} }); })) === "denied");
  c("serve cred: its own queue-qualified class subscribe is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { queue: q, callback: () => {} }); })) === "allowed");
  c("serve cred: the WRONG queue group on its own class rail is denied (the grant pins the queue)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { queue: "otherq", callback: () => {} }); })) === "denied");
  c("serve cred: the derived describe class rail is queue-subscribable",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.describe.>`, { queue: q, callback: () => {} }); })) === "allowed");
  c("serve cred: an UNREGISTERED command's class rail is denied (per-command rows)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.stop.>`, { queue: q, callback: () => {} }); })) === "denied");
  c("serve cred: a FOREIGN endpoint's class rail is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.delivery.status.>`, { queue: epClassQueueGroup("delivery"), callback: () => {} }); })) === "denied");
  c("serve cred: ANOTHER instance's inst rail is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.inst.manager.${IID_B}.status.>`, { callback: () => {} }); })) === "denied");
  c("serve cred: NO agent baseline rides along (chat subscribe is denied)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.chat.>`, { callback: () => {} }); })) === "denied");

  // ---- timer fire: the own epoch-pinned READ is granted, nothing else ----
  c("serve cred: its OWN epoch-pinned timer .fire read is granted (§13.9 Timer fire consume)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ept.manager.${IID}.${EPOCH}.*.fire`, { callback: () => {} }); })) === "allowed");
  c("serve cred: another EPOCH's timer .fire read is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ept.manager.${IID}.${EPOCH + 1}.*.fire`, { callback: () => {} }); })) === "denied");
  c("serve cred: another INSTANCE's timer .fire read is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ept.manager.${IID_B}.${EPOCH}.*.fire`, { callback: () => {} }); })) === "denied");

  // ---- DENY: epoch-pinned egress ----
  const NONCE = "n".repeat(24);
  const replyTail = `u_abc.worker.${UID}.${NONCE}`;
  c("serve cred: reply publish at its OWN epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ep.reply.manager.${IID}.${EPOCH}.${replyTail}`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: reply publish at ANOTHER epoch is denied (epoch-pinned attribution)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ep.reply.manager.${IID}.${EPOCH + 1}.${replyTail}`, new Uint8Array(0)); })) === "denied");
  c("serve cred: event publish at its own epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epe.manager.${IID}.${EPOCH}.progress`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: event publish at another epoch is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epe.manager.${IID}.${EPOCH + 1}.progress`, new Uint8Array(0)); })) === "denied");
  c("serve cred: a timer SCHEDULE request at its own epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ept.manager.${IID}.${EPOCH}.t1.schedule`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: the timer .armed phase is denied (only the timer writer arms, ADR-51 closure)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ept.manager.${IID}.${EPOCH}.t1.armed`, new Uint8Array(0)); })) === "denied");
  c("serve cred: the timer .fire phase PUBLISH is denied (fire is a read, no credential fires)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ept.manager.${IID}.${EPOCH}.t1.fire`, new Uint8Array(0)); })) === "denied");
  c("serve cred: record-write ingress at its own epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epr.manager.${IID}.${EPOCH}.svc.${IID}`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: record-write ingress at another epoch is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epr.manager.${IID}.${EPOCH + 1}.svc.${IID}`, new Uint8Array(0)); })) === "denied");
  c("serve cred: another INSTANCE's record ingress is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epr.manager.${IID_B}.${EPOCH}.svc.${IID_B}`, new Uint8Array(0)); })) === "denied");

  // ---- DENY: the caller credential holds no serve-side authority ----
  c("caller cred: the class rail is not subscribable, queue or plain (nonces stay private)",
    (await probe(callerCreds, callerId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { queue: q, callback: () => {} }); })) === "denied"
    && (await probe(callerCreds, callerId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { callback: () => {} }); })) === "denied");
  c("caller cred: an UNMINTED command's request publish is denied (default-deny per capability)",
    (await probe(callerCreds, callerId.id, (nc) => { nc.publish(`${p}.ep.one.manager.stop.u_abc.worker.${UID}.${NONCE}`, new Uint8Array(0)); })) === "denied");
  c("caller cred: a reply-rail publish (forged responder) is denied",
    (await probe(callerCreds, callerId.id, (nc) => { nc.publish(`${p}.ep.reply.manager.${IID}.${EPOCH}.${replyTail}`, new Uint8Array(0)); })) === "denied");
  c("caller cred: forging the instance's EVENT plane is denied",
    (await probe(callerCreds, callerId.id, (nc) => { nc.publish(`${p}.epe.manager.${IID}.${EPOCH}.progress`, new Uint8Array(0)); })) === "denied");
  c("caller cred: forging the instance's timer SCHEDULE request is denied",
    (await probe(callerCreds, callerId.id, (nc) => { nc.publish(`${p}.ept.manager.${IID}.${EPOCH}.t1.schedule`, new Uint8Array(0)); })) === "denied");
  c("caller cred: forging the instance's record-write ingress is denied",
    (await probe(callerCreds, callerId.id, (nc) => { nc.publish(`${p}.epr.manager.${IID}.${EPOCH}.svc.${IID}`, new Uint8Array(0)); })) === "denied");

  // ---- the admin god-view is the MESSAGING plane only (SPEC 13.9/13.11) ----
  const adminId = newIdentity();
  const adminCreds = await mintCreds(auth, adminId, "admin", {});
  c("admin cred: the space-wide `>` subscribe is denied (no plane-crossing god sub)",
    (await probe(adminCreds, adminId.id, (nc) => { nc.subscribe(`${p}.>`, { callback: () => {} }); })) === "denied");
  c("admin cred: an ep.one request rail subscribe is denied (reply nonces stay protected)",
    (await probe(adminCreds, adminId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { callback: () => {} }); })) === "denied");
  c("admin cred: the chat plane stays subscribable (the enumerated messaging god-view)",
    (await probe(adminCreds, adminId.id, (nc) => { nc.subscribe(`${p}.chat.>`, { callback: () => {} }); })) === "allowed");
  c("admin cred: the unicast (inst) plane stays subscribable",
    (await probe(adminCreds, adminId.id, (nc) => { nc.subscribe(`${p}.inst.>`, { callback: () => {} }); })) === "allowed");
  c("admin cred: the anycast (svc) plane stays subscribable",
    (await probe(adminCreds, adminId.id, (nc) => { nc.subscribe(`${p}.svc.>`, { callback: () => {} }); })) === "allowed");
} finally {
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => { srv.once("exit", () => resolve()); setTimeout(resolve, 3000); });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nENDPOINT SERVE AUTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
process.exit(fail > 0 ? 1 : 0);
