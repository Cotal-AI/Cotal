/**
 * MANAGER SERVICE ENDPOINT smoke (control-surface P2 item 1, 1a-serve) — a REAL Manager on a real
 * JWT broker registers as an ordinary v0.4 `service` endpoint and dual-serves its typed 1a
 * surface, proving the panel's binding 1a checklist end to end:
 *
 *  1. GATE BEFORE REGISTER (checklist 1): start() provisions the §13.1 issuance gate
 *     `epgate.manager.<managerLifecycleUid>` and the registration traverses its barrier — after
 *     start the gate is OPEN at generation 1 with the spec's store revision stamped.
 *  2. NO SEED SHORTCUT (checklist 2): the serve credential is LEDGERED (`epcred.…`, state active,
 *     staged at generation 1 = through the post-registration gate CAS) for exactly the minted
 *     JWT's digest — and the manager's STANDING supervisor credential is broker-DENIED the epgate
 *     write, so the traversal could only have ridden the scoped one-shot executor.
 *  3. F5(a)/maintenance CHOKEPOINT (checklist 3/8): a retired managed principal is refused on
 *     `ep.one` (permission-denied), and a resume-pending manager refuses ep ops (`unavailable`);
 *     both restore. (Since 1d the ep door is the only control door.)
 *  4. processEpoch ≠ instanceId (checklist 4): the served epoch is the GATE's processEpoch (0),
 *     while instanceId is the manager's lifecycle uid.
 *  5. Typed invoke + describe (the 1a walking skeleton): a caller-cred `epCall` over `ep.one`
 *     (with the gate-backed currency reader, checklist 6) returns the digest-bound ManagerStatus;
 *     `describe` returns the public descriptor.
 *  6. STANDING RENEWAL through the fence (checklist 7): a re-mint of the SAME serve identity
 *     stages a SECOND active ledger row (distinct per-JWT id, same nkey) behind the gate CAS.
 *  7. stop() tears the serve loop down — the ep rail stops answering.
 *
 * Run: pnpm smoke:manager-service   (needs nats-server + node on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity, idFromCreds,
  mintLifecycleUid, standaloneConnectOpts, principalKey, DEV_OWNER,
  recordsBucket, epAuthBucket, epgateKey, parseEndpointGate,
  epcredFamilyPrefix, parseLedgerRow, rawDigest, recordSpecKey, RECORD_KINDS,
  epCall, epRequestSubject, epCallerReplyFilter, EpEnvelopeError,
  serveIssuanceGateKv,
  type EpServeLedgerRow,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_STATUS_CONTRACT, type ManagerStatus } from "../src/manager-service-contract.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const enc = new TextEncoder(), dec = new TextDecoder();

const space = `mgrsvc-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-mgrsvc-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth); // the manager's start() reloads auth from disk
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
// The smoke reaches private state ONLY to observe/force fence states the wire cannot cheaply
// produce (retired principal, resume-pending) and to read the minted serve identity.
const M = mgr as unknown as {
  managerLifecycleUid: string;
  serviceServe?: { identity: { id: string; seed: string }; creds: string; grant: { epoch: number; instanceId: string; registrationRevision: number } };
  retiredPrincipals: Set<string>;
  resumeRequired: boolean;
  withEndpointServeExecutor: <T>(fn: (kvs: { recordsKv: KV; authKv: KV }) => Promise<T>) => Promise<T>;
};

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();
  const iid = M.managerLifecycleUid;

  // Inspection connection: an endpoint-serve-executor cred READS both authority stores (its
  // writes are key-pinned to this same instance, unused here).
  const inspCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: iid },
  });
  const inspNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: inspCreds }), maxReconnectAttempts: 0 });
  const kvm = new Kvm(inspNc);
  const authKv = await kvm.open(epAuthBucket(space));
  const recKv = await kvm.open(recordsBucket(space));
  const gateKey = epgateKey(MANAGER_ENDPOINT, iid);
  const readGate = async () => parseEndpointGate((await authKv.get(gateKey))!.value, gateKey);
  const credRows = async (): Promise<EpServeLedgerRow[]> => {
    const rows: EpServeLedgerRow[] = [];
    const it = await authKv.keys(`${epcredFamilyPrefix(MANAGER_ENDPOINT, iid)}.>`);
    for await (const k of it) rows.push(parseLedgerRow((await authKv.get(k))!.value, k));
    return rows;
  };

  console.log("1. registration through the §13.1 gate (checklist 1/2/4)");
  check("start() registered the service (serve state present)", M.serviceServe !== undefined);
  const specEntry = await recKv.get(recordSpecKey(RECORD_KINDS.svc, [MANAGER_ENDPOINT, iid]));
  check("the svc spec record exists for (manager, managerLifecycleUid)", specEntry !== null && specEntry.operation === "PUT");
  const gate = await readGate();
  const servePrincipal = principalKey(DEV_OWNER, M.serviceServe!.identity.id).key;
  check("the gate is OPEN at generation 1 (the registration barrier traversed it: freeze -> reopen)",
    gate.state === "open" && gate.generation === 1, gate);
  check("the gate's registrationRevision is the spec's store revision (the §13.7 coordinate)",
    specEntry !== null && gate.registrationRevision === specEntry.revision, { gate: gate.registrationRevision, spec: specEntry?.revision });
  check("the gate binds the SERVE principal (minted before the gate, §13.1 serving-principal binding)",
    gate.principal === servePrincipal, { gate: gate.principal, servePrincipal });
  check("processEpoch is the GATE's (0), instanceId the lifecycle uid — never conflated (checklist 4)",
    gate.processEpoch === 0 && M.serviceServe!.grant.epoch === 0 && M.serviceServe!.grant.instanceId === iid);
  const family1 = await credRows();
  const rows1 = family1.filter((r) => r.holderPrincipal === servePrincipal);
  const expectId = rawDigest(M.serviceServe!.creds).replace("sha256:", "sha256-");
  check("EXACTLY one ACTIVE serve ledger row exists (the released credential's §13.1 row)",
    rows1.length === 1 && rows1[0].state === "active", rows1);
  check("the §13.1 family ALSO carries the goal-writer sibling (must-5 (b): a distinct active holder the takeover barrier revokes+evicts together)",
    family1.some((r) => r.holderPrincipal !== servePrincipal && r.state === "active"), family1);
  check("the row IS the minted JWT (per-JWT digest id), held by the serve principal, with a BOUNDED exp (through the gate CAS, not a seed-signed shortcut; no unbounded serve JWT)",
    rows1[0].credentialId === expectId && rows1[0].holderPrincipal === servePrincipal
    && typeof rows1[0].exp === "number" && rows1[0].exp > Date.now() / 1000, rows1[0]);

  // The STANDING supervisor credential is broker-DENIED the epgate write: the only path to the
  // traversal above is the scoped executor (checklist 2's negative half). A foreign-instance gate
  // key keeps the probe harmless even if it were (wrongly) admitted.
  {
    const supCreds = await mintCreds(auth, newIdentity(), "supervisor");
    const supNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: supCreds }), maxReconnectAttempts: 0 });
    let denied = false;
    try {
      await supNc.request(`$KV.${epAuthBucket(space)}.${epgateKey(MANAGER_ENDPOINT, "z".repeat(26))}`, enc.encode("{}"), { timeout: 1500 });
    } catch { denied = true; }
    check("the STANDING supervisor cred is broker-DENIED an epgate write (no seed shortcut is even reachable)", denied);
    await supNc.drain().catch(() => supNc.close());
  }

  console.log("2. typed invoke over ep.one + describe (checklist 6/9)");
  const callerId = newIdentity();
  const callerUid = mintLifecycleUid();
  const caller = { owner: DEV_OWNER, actor: callerId.id, uid: callerUid };
  const callerCreds = await mintCreds(auth, callerId, "agent", {
    lifecycleUid: callerUid,
    endpointCapabilities: [{ endpoint: MANAGER_ENDPOINT, command: "status" }],
  });
  const callerNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: callerCreds }), maxReconnectAttempts: 0 });
  // checklist 6: the `one`-rail currency reader is the GATE's processEpoch (the service epoch
  // authority), read fresh per reply — never a bare call.
  const serviceEpochReader = async () => (await readGate()).processEpoch;
  const callStatus = () => epCall(callerNc, space, { mode: "one" },
    { endpoint: MANAGER_ENDPOINT, command: "status", contract: MANAGER_STATUS_CONTRACT, caller },
    { deadlineMs: 8000, currentEpoch: serviceEpochReader });
  const r1 = await callStatus();
  const s1 = r1.reply.data as ManagerStatus;
  check("epCall(one, status) answers ok with the digest-bound typed reply", r1.reply.ok === true, r1.reply);
  check("the status is the manager's real health (instanceId = uid, runtime pty, 0 agents)",
    s1.instanceId === iid && s1.runtime === "pty" && s1.agentCount === 0 && s1.uptimeMs >= 0, s1);
  check("the reply subject attributes the registered incarnation (instanceId + epoch 0)",
    r1.responder.instanceId === iid && r1.responder.epoch === 0, r1.responder);

  // describe rides the caller BASELINE (wildcard describe row) — raw request form (describe pins
  // no digests, so it doesn't ride epCall's contract-stamping path).
  {
    const replies: unknown[] = [];
    const sub = callerNc.subscribe(epCallerReplyFilter(space, caller), {
      callback: (_e, m) => replies.push(JSON.parse(dec.decode(m.data))),
    });
    const n = `n${String(Date.now()).padStart(23, "0")}`;
    const subj = epRequestSubject(space, { route: { mode: "one" }, endpoint: MANAGER_ENDPOINT, command: "describe", caller, nonce: n });
    callerNc.publish(subj, enc.encode(JSON.stringify({
      v: 1, id: "d1", op: { endpoint: MANAGER_ENDPOINT, command: "describe" }, class: "ephemeral",
      replyExpected: true, deadlineMs: 3000, from: { id: `${DEV_OWNER}.${callerId.id}`, name: "smoke" },
    })));
    await callerNc.flush();
    for (let i = 0; i < 60 && replies.length === 0; i++) await wait(100);
    const d = replies[0] as { ok?: boolean; data?: { public?: boolean; descriptor?: { endpoint?: string; owner?: string; clusters?: Array<{ commands?: string[] }> } } } | undefined;
    check("describe answers the PUBLIC descriptor with the registered `status` command",
      d?.ok === true && d.data?.public === true && d.data.descriptor?.endpoint === MANAGER_ENDPOINT
      && d.data.descriptor?.owner === DEV_OWNER && d.data.descriptor?.clusters?.[0]?.commands?.includes("status") === true,
      JSON.stringify(d));
    sub.unsubscribe();
  }

  console.log("3. ONE shared F5(a)/maintenance chokepoint on the ep door (checklist 3/8)");
  const callerPrincipal = principalKey(DEV_OWNER, callerId.id).key;
  M.retiredPrincipals.add(callerPrincipal);
  const rRet = await callStatus();
  check("a RETIRED managed principal is refused on ep.one (permission-denied, F5(a))",
    rRet.reply.ok === false && rRet.reply.error?.code === "permission-denied"
    && String(rRet.reply.error?.message ?? "").includes("retired"), rRet.reply);
  M.retiredPrincipals.delete(callerPrincipal);
  M.resumeRequired = true;
  const rRes = await callStatus();
  check("a resume-pending manager refuses ep ops (unavailable, the maintenance fence)",
    rRes.reply.ok === false && rRes.reply.error?.code === "unavailable"
    && String(rRes.reply.error?.message ?? "").includes("resume"), rRes.reply);
  M.resumeRequired = false;
  check("the fences RESTORE (the caller invokes again after both clear)", (await callStatus()).reply.ok === true);

  console.log("4. standing renewal through the mint fence (checklist 7)");
  const before = M.serviceServe!.creds;
  // A renewal minutes later always differs; here 1.1s guarantees a fresh iat/exp second (the
  // ed25519 signature is deterministic, so a same-second re-mint would be byte-identical and the
  // create-only stage would — correctly — treat it as the SAME issuance).
  await wait(1100);
  M.serviceServe!.creds = await M.withEndpointServeExecutor(({ authKv: execAuthKv }) =>
    mintCreds(auth, M.serviceServe!.identity, "endpoint-serve", {
      serveIssuance: serveIssuanceGateKv(execAuthKv, space, { endpoint: MANAGER_ENDPOINT, instanceId: iid }),
      endpointServe: M.serviceServe!.grant as never,
    }));
  const rows2 = (await credRows()).filter((r) => r.holderPrincipal === servePrincipal);
  check("the renewal released a NEW credential for the SAME stable serve nkey",
    M.serviceServe!.creds !== before && idFromCreds(M.serviceServe!.creds) === M.serviceServe!.identity.id);
  check("the renewal staged a SECOND ACTIVE serve ledger row behind the gate CAS (distinct per-JWT id, no overwrite)",
    rows2.length === 2 && rows2.every((r) => r.state === "active" && r.holderPrincipal === servePrincipal)
    && new Set(rows2.map((r) => r.credentialId)).size === 2, rows2);
  check("the ep rail still answers after renewal (the standing serve connection is undisturbed)",
    (await callStatus()).reply.ok === true);

  console.log("5. stop() tears the serve loop down");
  await inspNc.drain().catch(() => inspNc.close());
  await mgr.stop();
  let downRefusal: string | undefined;
  try {
    await epCall(callerNc, space, { mode: "one" },
      { endpoint: MANAGER_ENDPOINT, command: "status", contract: MANAGER_STATUS_CONTRACT, caller },
      { deadlineMs: 2500, currentEpoch: async () => 0 });
  } catch (e) {
    downRefusal = e instanceof EpEnvelopeError ? e.code : (e as Error).message;
  }
  check("after stop() the ep rail no longer answers (no responder / deadline, never a stale reply)",
    downRefusal === "unavailable" || downRefusal === "deadline-exceeded", downRefusal);

  console.log("6. RE-UP / UPGRADE path: a SECOND manager against the EXISTING store registers (the tester's regression)");
  // The store already holds this manager endpoint's contract artifacts from the first boot, so the
  // second registration RE-PUBLISHES them: every publishContractArtifact loses the create-only CAS
  // and runs its verify-read. The executor cred MUST hold the EPC Direct Get read grant or the
  // manager exits here (the 0659a9c regression). A fresh manager process = a fresh instanceId.
  const mgr2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
  const M2 = mgr2 as unknown as { managerLifecycleUid: string; serviceServe?: unknown };
  let reupErr: string | undefined;
  try { await mgr2.start(); } catch (e) { reupErr = (e as Error).message; }
  check("the re-up manager started (no broker-denied verify-read on the re-published artifacts)", reupErr === undefined, reupErr);
  check("the re-up manager registered its service on a FRESH instanceId", M2.serviceServe !== undefined && M2.managerLifecycleUid !== iid);
  const reupCaller = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: callerCreds }), maxReconnectAttempts: 0 });
  const rReup = await epCall(reupCaller, space, { mode: "one" },
    { endpoint: MANAGER_ENDPOINT, command: "status", contract: MANAGER_STATUS_CONTRACT, caller },
    { deadlineMs: 8000, currentEpoch: async () => 0 });
  check("the re-up manager serves status (the store + registration survived the upgrade path)",
    rReup.reply.ok === true && (rReup.reply.data as ManagerStatus).instanceId === M2.managerLifecycleUid, rReup.reply);
  await reupCaller.drain().catch(() => reupCaller.close());
  await mgr2.stop();
  await callerNc.drain().catch(() => callerNc.close());
} finally {
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "MANAGER SERVICE SMOKE OK ✅" : "MANAGER SERVICE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
