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
  type EpIssuanceGate, type EpGateState, type EpServeLedgerRow,
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

/** In-process KV stub carrying the registration the PROVISIONER authorizes against — the
 *  broker's job in this smoke is enforcing the minted ROWS; the registry read itself is the
 *  provisioner's trusted seam (its broker-side grant is the D14 gate). */
function memKv(): KV {
  const store2 = new Map<string, { value: Uint8Array; revision: number; operation: "PUT" }>();
  let seq = 0;
  return {
    get: async (k: string) => store2.get(k),
    create: async (k: string, v: Uint8Array) => {
      if (store2.has(k)) throw new Error(`wrong last sequence: ${k} exists`);
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

/** A faithful in-memory model of the §13.1 durable issuance gate (`gate.<lifecycleUid>`): ONE
 *  key binding `{state, generation, processEpoch, registrationRevision, revision}`, with a
 *  revision-pinned CAS. `commit` is the mint's serialization point; `freeze` is what a takeover
 *  or a re-registration barrier CASes FIRST — both advance `revision`, so exactly one of a
 *  parked mint's `commit` and a barrier's `freeze` wins. The staged ledger rows are the
 *  `cred.` rows a barrier would enumerate and revoke. */
function makeGate(init: { generation: number; processEpoch: number; registrationRevision: number }) {
  const gate = { state: "open" as "open" | "frozen" | "retired", ...init, revision: 1 };
  const rows = new Map<string, { row: EpServeLedgerRow; state: "staged" | "revoked" }>();
  const seam: EpIssuanceGate = {
    observe: (): EpGateState => ({ ...gate }),
    stage: (row) => { rows.set(row.credentialId, { row, state: "staged" }); },
    commit: (expectedRevision) => {
      if (gate.state !== "open" || gate.revision !== expectedRevision) return false;
      gate.revision++; // a winning mint advances the gate revision, staying open at the same tuple
      return true;
    },
    revoke: (row) => { const e = rows.get(row.credentialId); if (e) e.state = "revoked"; },
  };
  return {
    seam, rows,
    /** A barrier (takeover or re-registration) CAS-freezes the gate BEFORE enumerating. */
    freeze: () => { gate.state = "frozen"; gate.revision++; },
    /** Reopen at successor authority coordinates (post-enumeration barrier step). */
    reopen: (next: { processEpoch?: number; registrationRevision?: number }) => {
      gate.state = "open"; gate.generation++; gate.revision++;
      if (next.processEpoch !== undefined) gate.processEpoch = next.processEpoch;
      if (next.registrationRevision !== undefined) gate.registrationRevision = next.registrationRevision;
    },
    staged: () => [...rows.values()].filter((e) => e.state === "staged").length,
    revoked: () => [...rows.values()].filter((e) => e.state === "revoked").length,
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
  const authority: ServiceNameAuthority = { isOperatorOwner: (o) => o === "u_op", domainOwnerOf: () => undefined };
  const kv = memKv();
  const svcSpec = { endpoint: "manager", owner: "u_op", clusterDigests: [DC], protocol: { v: 1 as const } };
  const reg = await registerServiceInstance(kv, { spec: svcSpec, instanceId: IID, registrant: { owner: "u_op" }, authority });
  const serveGrant = await authorizeServeGrant(kv, {
    space, endpoint: "manager", instanceId: IID, epoch: EPOCH,
    holder: { owner: "u_op" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact,
  });
  c("a registered instance's serve artifact authorizes for minting (verified full surface, bound space/owner)",
    serveGrant.commands.length === 1 && serveGrant.commands[0] === "status" && serveGrant.space === space && serveGrant.owner === "u_op"
    && serveGrant.registrationRevision === reg.registrationRevision);
  await rejects("a FOREIGN NAME cannot authorize a mintable serve artifact (holder is not the registered owner)",
    () => authorizeServeGrant(kv, { space, endpoint: "manager", instanceId: IID, epoch: EPOCH, holder: { owner: "u_evil" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact }), "permission-denied");
  await rejects("a FOREIGN INSTANCE cannot authorize (unregistered)",
    () => authorizeServeGrant(kv, { space, endpoint: "manager", instanceId: IID_B, epoch: EPOCH, holder: { owner: "u_op" }, authority, readProcessEpoch: () => EPOCH, readClusterArtifact }), "failed-precondition");

  // ---- the durable issuance gate is the mint fence (SPEC 13.1); the gate binds epoch + reg rev ----
  const gate = makeGate({ generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision });
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
  c("the endpoint-serve profile without an artifact refuses",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, serveIssuance: gate.seam }));
  c("the endpoint-serve profile without the issuance gate refuses (the release fence is mandatory)",
    await mintThrows({ principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant }));

  // ---- mint the restricted profiles (each mint wins its own CAS on the open gate) ----
  const serveId = newIdentity();
  const serveCreds = await mintCreds(auth, serveId, "endpoint-serve", {
    principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam,
  });
  c("the mint STAGED its credential-ledger row and WON the gate CAS (one committed row)",
    gate.staged() === 1 && gate.revoked() === 0);
  c("a SECOND mint from the same artifact wins its own fresh CAS (standing-renewable re-mint)",
    (await mintServe()).includes("USER JWT") && gate.staged() === 2);

  // ---- mint context binding (space + principal) ----
  await rejects("a FOREIGN PRINCIPAL cannot mint from the artifact (the minted principal IS the registered owner)",
    () => mintServe({ principal: { owner: "u_evil", actor: "mgr" } }), "permission-denied");
  {
    const foreign = await createSpaceAuth("foreignspace");
    await rejects("a CROSS-SPACE mint refuses (the artifact binds its space)",
      () => mintCreds(foreign, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: gate.seam }), "permission-denied");
  }

  // ---- the durable fence: parked mint vs takeover, and vs re-registration (SPEC 13.1) ----
  // A gate whose epoch/reg-rev has already advanced past the artifact's is `expired` at observe.
  {
    const drifted = makeGate({ generation: 2, processEpoch: EPOCH + 1, registrationRevision: reg.registrationRevision });
    await rejects("EPOCH DRIFT: the gate is at a newer processEpoch than the artifact; mint refuses, releases nothing",
      () => mintServe({ serveIssuance: drifted.seam }), "expired");
    c("…and the drifted mint staged NO surviving row (it never reached the CAS)", drifted.staged() === 0);
  }
  {
    const reReg = makeGate({ generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision + 1 });
    await rejects("RE-REGISTRATION DRIFT: the gate is at a newer registrationRevision; mint refuses (superseded surface)",
      () => mintServe({ serveIssuance: reReg.seam }), "expired");
  }
  {
    const frozenGate = makeGate({ generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision });
    frozenGate.freeze(); // a takeover/re-registration barrier CAS-froze the gate FIRST
    await rejects("a FROZEN gate refuses the mint (a barrier won the single-key serialization)",
      () => mintServe({ serveIssuance: frozenGate.seam }), "expired");
  }
  // Parked-mint-vs-takeover: the mint observes an OPEN gate, then a barrier freezes it before the
  // mint's CAS. The CAS loses, the staged row is revoked, and NO credential is released.
  {
    const raceGate = makeGate({ generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision });
    let barrierWon = false;
    const racing: EpIssuanceGate = {
      observe: raceGate.seam.observe,
      stage: (row) => { raceGate.seam.stage(row); raceGate.freeze(); barrierWon = true; }, // barrier freezes between stage and commit
      commit: raceGate.seam.commit,
      revoke: raceGate.seam.revoke,
    };
    let released = "";
    try { released = await mintCreds(auth, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: racing }); } catch { /* expected */ }
    c("parked-mint-vs-takeover: the barrier's freeze wins the CAS, the mint releases NOTHING and revokes its staged row",
      barrierWon && released === "" && raceGate.staged() === 0 && raceGate.revoked() === 1);
  }
  // Parked-mint-vs-re-registration: same single-key serialization, the barrier advancing the
  // registrationRevision. The mint's revision-pinned CAS loses; nothing is released.
  {
    const raceGate = makeGate({ generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision });
    const racing: EpIssuanceGate = {
      observe: raceGate.seam.observe,
      stage: (row) => { raceGate.seam.stage(row); raceGate.freeze(); raceGate.reopen({ registrationRevision: reg.registrationRevision + 1 }); },
      commit: raceGate.seam.commit,
      revoke: raceGate.seam.revoke,
    };
    let released = "";
    try { released = await mintCreds(auth, newIdentity(), "endpoint-serve", { principal: { owner: "u_op", actor: "mgr" }, endpointServe: serveGrant, serveIssuance: racing }); } catch { /* expected */ }
    c("parked-mint-vs-re-registration: the re-registration barrier wins, the mint releases NOTHING and revokes its row",
      released === "" && raceGate.revoked() === 1);
  }
  // finalizeServeIssuance is only released on a genuine CAS win: prove the winning path directly.
  {
    const winGate = makeGate({ generation: 1, processEpoch: EPOCH, registrationRevision: reg.registrationRevision });
    await finalizeServeIssuance(winGate.seam, serveGrant, newIdentity().id);
    c("a mint that wins the CAS on an open, current gate commits its row (the positive fence path)",
      winGate.staged() === 1 && winGate.revoked() === 0);
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
