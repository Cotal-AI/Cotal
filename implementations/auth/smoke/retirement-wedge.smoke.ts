/**
 * #878: a crash between the retirement barrier's last two steps (gate terminal, step 8, then
 * head terminal, step 9) leaves `gate retired by the op` + `head retiring under the op`. The
 * head is non-current AND not replaceable (SPEC 13.1), and the gate-only boot-resume predicate
 * skipped the intent forever: nothing minted for the alias and nothing could ever replace it —
 * a permanently wedged alias with a clean-looking boot log.
 *
 * THE CRASH WINDOW IS STAGED, NOT INJECTED, because the barrier's last two steps are adjacent
 * sealed-registry CASes with no injectable seam: the barrier RUNS FOR REAL through intent
 * create, gate freeze, head `active → retiring`, and family containment, and ABORTS at verified
 * eviction (fail-closed — eviction cannot verify, so the barrier refuses; the deps past that
 * point are unreachable stubs). The two durable writes a successful eviction would have
 * preceded are then replayed with the barrier's OWN primitives (the frontier record, step 7,
 * exactly as the barrier records each stream's last_seq; the gate terminal via `retireGate`,
 * step 8), and the head terminal (step 9) NEVER RUNS. That durable state is what a real crash
 * between steps 8 and 9 leaves.
 *
 * THE ACCEPTANCE CELL (the issue's refined criteria — both triggers, neither presupposed):
 *  - the wedge is REPRODUCED first: the intermediate state is asserted (gate retired by the op,
 *    head still retiring under the op, intent + frontier durable), and the same-name respawn a
 *    real manager would attempt is REFUSED at the public issuance seam;
 *  - trigger A (the next auth boot, over the REAL plane) REPAIRS: the boot resumes the same
 *    intent and the head lands `retired`;
 *  - trigger B (a same-op re-request through the REAL retire-lifecycle rail) REPAIRS on an
 *    independently staged second wedge: the rail re-enters the barrier, whose gate-retired
 *    branch finishes the head tail;
 *  - BOTH converge on the SAME executor (runAgentRetirementBarrier's gate-retired branch; the
 *    boot resume just calls it through resumeAgentRetirement);
 *  - NEITHER replays a foreign op: a stranger's opId is refused (`not-found`), the resume is
 *    pinned to this op's coordinates, and the completed cell (gate retired + head retired)
 *    stays skipped on a later boot.
 *
 * The suite owns its broker, its port, its state dir, and its store. It never touches
 * `~/.cotal`, the live fleet, or any ambient mesh. Broker killed by exact PID.
 *
 * Run: pnpm smoke:retirement-wedge:auth   (needs nats-server on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, epAuthBucket, epgateKey,
  epCallerReplyFilter, epRequestSubject, parseEpSubject,
  createEndpointStreams, createRecordEntry, createSpaceAuth, ensureAuthorityStores,
  epfStreamName, epwStreamName, isReachable, mintCreds, mintLifecycleUid, newIdentity,
  principalKey, recordAtomicKey, RETIREMENT_FRONTIER, serverConfig, DEV_OWNER,
  type EvictionResult, type PlaneConnTuple, type PlaneLivenessQuery, type PlaneLivenessResult,
} from "@cotal-ai/core";
import { deriveOwnerToken, openAuthAuthorityPlane } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { openLifecycleRegistry, observeGate, readLifecycleHeadForOperation, registryStores, retireGate, activateLifecycleAtUid } from "../src/lifecycle-registry.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { stageIntentKey, type EvictPrincipal } from "../src/credential-ledger.js";
import { runAgentRetirementBarrier, resumeAgentRetirement, type RetirementDeps } from "../src/retirement-barrier.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const rejects = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error)?.message ?? String(e); } };

const space = `rwedge-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const okEvictor = (calls: string[]): EvictPrincipal => async (principal) => {
  calls.push(principal);
  return { principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult;
};
/** The fail-closed seam: eviction cannot verify, so the barrier aborts AFTER freezing the gate
 *  and retiring the head — the real mid-crash state, with the gate still FROZEN (resumable under
 *  the old predicate too). The staged gate terminal below is what makes it the #878 window. */
const failEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 1, verifiedGone: false, scanComplete: true, note: "probe: staged crash at verified eviction" });
const unreached = (what: string) => async (): Promise<never> => { throw new Error(`${what} must not be reached while staging the crash window`); };

// The rail's serve registration (manager instance gate), staged exactly like auth-admin.smoke.ts.
const MGR_SERVE = newIdentity();
const MGR = { owner: DEV_OWNER, actor: MGR_SERVE.id, uid: mintLifecycleUid() };
const MGR_INST = mintLifecycleUid();
const SERVE_EPOCH = 1;
const MGR_KEY = principalKey(DEV_OWNER, MGR_SERVE.id).key;

/** One rail request over a FRESH requester credential (the real mint + real broker ACLs), exactly
 *  as auth-admin.smoke.ts drives the retire-lifecycle rail. */
async function railRequest(
  caller: { owner: string; actor: string; uid: string },
  target: { owner: string; actor: string; lifecycleUid: string },
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string } | "no-reply"> {
  const creds = await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: { ...caller, target } });
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
  const nonce = randomUUID().replace(/-/g, "") + "aaaaaaaa";
  try {
    const subject = epRequestSubject(space, {
      route: { mode: "one" }, endpoint: AUTH_ENDPOINT, command: EP_CMD_RETIRE_LIFECYCLE,
      target: { mode: "handle", tOwner: target.owner, tActor: target.actor, tUid: target.lifecycleUid },
      caller, nonce,
    });
    const fullArgs = { serveEndpoint: "manager", serveInstanceId: MGR_INST, serveEpoch: SERVE_EPOCH, ...args };
    const requestId = randomUUID().replace(/-/g, "");
    let settle: (v: { ok: boolean; data?: Record<string, unknown>; error?: string } | "no-reply") => void;
    const got = new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string } | "no-reply">((res) => { settle = res; });
    const sub = nc.subscribe(epCallerReplyFilter(space, caller), {
      callback: (_err, msg) => {
        const parsed = parseEpSubject(msg.subject);
        if (!parsed || parsed.plane !== "reply" || parsed.endpoint !== AUTH_ENDPOINT || parsed.nonce !== nonce) return;
        let body: { ok: boolean; id?: unknown; data?: Record<string, unknown>; error?: string };
        try { body = JSON.parse(new TextDecoder().decode(msg.data)) as typeof body; } catch { return; }
        if (body.id !== requestId) return;
        settle(body);
      },
    });
    const timer = setTimeout(() => settle("no-reply"), 8000);
    nc.publish(subject, new TextEncoder().encode(JSON.stringify({ id: requestId, op: "retireLifecycle", args: fullArgs })));
    const out = await got;
    clearTimeout(timer);
    try { sub.unsubscribe(); } catch { /* down */ }
    return out;
  } catch (e) {
    if (/timeout|no responders|permission/i.test((e as Error).message)) return "no-reply";
    throw e;
  } finally {
    await nc.close().catch(() => {});
  }
}

let writer: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
// The plane-claim oracle's deterministic twin: this suite has no delivery daemon (its broker is
// throwaway), yet it boots the plane back-to-back, and a clean close's `held → released` CAS can
// lose the race against the next open's read. A `held` row then needs reclaim adjudication, which
// the production oracle routes over `ctl.delivery-admin` (unreachable here BY DESIGN). The twin
// answers the same question the daemon does, from the only ground truth this suite owns: whether
// a PRIOR plane's scanner tuples still have live connections. It registers every booted plane's
// candidates before the plane opens and deregisters them on close, so `gone` is the verdict of an
// awaited `gone` signal (the broker-observed disconnect), never a guess; an unknown tuple is
// `unknown` + incomplete sweep (the fail-safe refusal, exactly what the daemon would say).
const claimCandidates = new Map<string, { gone: Promise<void> }>();
const planeClaimOracle = async (query: PlaneLivenessQuery): Promise<PlaneLivenessResult> => {
  // A candidate's `gone` fires when its non-reconnecting connection is permanently gone; a
  // bounded race decides live-vs-gone NOW (an already-closed candidate resolves immediately, a
  // live one never resolves within the grace window).
  const state = async (t: PlaneConnTuple): Promise<"live" | "gone"> => {
    const c = claimCandidates.get(`${t.serverId}|${t.cid}|${t.userNkey}`);
    if (c === undefined) return "gone"; // this run never opened it: nothing of ours to keep alive
    return Promise.race([c.gone.then(() => "gone" as const), wait(50).then(() => "live" as const)]);
  };
  const ledger = await state(query.ledger), records = await state(query.records);
  const live = ledger === "live" || records === "live";
  return {
    ledger: { tuple: query.ledger, state: ledger },
    records: { tuple: query.records, state: records },
    sweepComplete: true,
    ...(live ? { note: "smoke oracle: a prior plane's scanner connection is still live" } : {}),
  };
};
/** Open the plane with the deterministic claim oracle, registering the candidates the SAME way
 *  openAuthAuthorityPlane does internally (they are plane-owned: closed when the plane closes). */
const bootPlane = async (opts: { log?: (l: string) => void; evictor: EvictPrincipal }) => {
  const [ledgerCand, recordsCand] = await Promise.all([
    (await import("../src/ledger-scanner.js")).openAuthLedgerScannerCandidate({ server: SERVERS, space, dataAccount, log: quiet }),
    (await import("../src/records-scanner.js")).openRecordsScannerCandidate({ server: SERVERS, space, dataAccount, log: quiet }),
  ]);
  for (const c of [ledgerCand, recordsCand])
    claimCandidates.set(`${c.tuple.serverId}|${c.tuple.cid}|${c.tuple.userNkey}`, { gone: c.gone });
  const p = await openAuthAuthorityPlane({
    server: SERVERS, space, dir, dataAccount,
    log: opts.log ?? quiet, probeEvictor: opts.evictor, probePlaneOracle: planeClaimOracle,
  });
  const close = p.close.bind(p);
  p.close = async () => {
    try { return await close(); } finally {
      for (const c of [ledgerCand, recordsCand])
        claimCandidates.delete(`${c.tuple.serverId}|${c.tuple.cid}|${c.tuple.userNkey}`);
    }
  };
  return p;
};
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // The broad permissive mint connection is the smoke suites' established seeding profile
  // (auth-admin.smoke.ts uses the same): the plane's real mint writer holds a narrower grant set
  // that excludes endpoint-stream provisioning, which belongs to space setup.
  writer = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const jsm = await jetstreamManager(writer.nc);
  const kvm = new Kvm(writer.nc);
  await ensureAuthorityStores(jsm, kvm, space);
  await createEndpointStreams(jsm, kvm, space); // the frontier step reads EPF/EPW last_seq
  const epKv = await kvm.open(epAuthBucket(space));
  await epKv.put(epgateKey("manager", MGR_INST), new TextEncoder().encode(JSON.stringify(
    { state: "open", generation: 1, processEpoch: SERVE_EPOCH, registrationRevision: 1, nameAuthorityRevision: 1, principal: MGR_KEY })));
  const wreg = await openLifecycleRegistry(writer.nc, space);
  const { recordsKv, authKv } = registryStores(wreg);

  /** Stage the #878 crash window for one alias: run the real barrier to its fail-closed abort,
   *  replay steps 7/8 with the barrier's own primitives, never run step 9. Returns the op. */
  const stageWedge = async (actor: string): Promise<{ uid: string; op: string }> => {
    const uid = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor, lifecycleUid: uid, managerInstance: "smoke" });
    const op = mintLifecycleUid();
    const deps: RetirementDeps = {
      evictPrincipal: failEvictor,
      drainTargetObligations: unreached("drain"),
      openCleaner: unreached("openCleaner"), retireCleanerCredential: unreached("retireCleanerCredential"),
      openExecutor: unreached("openExecutor"), retireExecutorCredential: unreached("retireExecutorCredential"),
      now: Date.now,
    };
    const abortMsg = await rejects(() => runAgentRetirementBarrier(wreg, {
      owner: OWNER, actor, lifecycleUid: uid, opId: op,
      frontierStreams: [epfStreamName(space), epwStreamName(space)],
    }, deps));
    if (abortMsg.length === 0) throw new Error(`staging the crash window for ${actor}: the barrier did not abort at verified eviction`);
    const streams: Record<string, number> = {};
    for (const s of [epfStreamName(space), epwStreamName(space)]) streams[s] = (await jsm.streams.info(s)).state.last_seq;
    await createRecordEntry(recordsKv, recordAtomicKey(RETIREMENT_FRONTIER, [uid]), { lifecycleUid: uid, opId: op, streams });
    const gateFrozen = await observeGate(wreg, uid);
    if (gateFrozen === undefined || gateFrozen.row.state !== "frozen" || gateFrozen.row.op?.opId !== op)
      throw new Error(`cannot stage the gate terminal for ${actor}: gate=${JSON.stringify(gateFrozen)}`);
    await retireGate(wreg, { lifecycleUid: uid, revision: gateFrozen.revision, opId: op }); // step 8
    return { uid, op }; // step 9 NEVER RUNS — the crash lands here
  };

  // =================================================================================================
  console.log("A. THE WEDGE: stage the crash window and reproduce it (independent of any trigger)");
  const A = "workerA";
  const wedge = await stageWedge(A);
  {
    const gate = await observeGate(wreg, wedge.uid);
    check("THE CRASH WINDOW: the gate is terminal `retired` by THIS op (NOT frozen — the old predicate's only owed cell)",
      gate?.row.state === "retired" && gate.row.op?.opId === wedge.op, gate?.row);
    const head = await readLifecycleHeadForOperation(wreg, OWNER, A);
    check("THE CRASH WINDOW: the head is still `retiring` under THIS op (the barrier's own last step never ran)",
      head?.mapping.state === "retiring" && head.mapping.op?.opId === wedge.op, head?.mapping);
    const intent = await authKv.get(stageIntentKey(wedge.op));
    check("THE CRASH WINDOW: the durable intent survives (only the head terminal drops it)",
      intent !== null && intent.operation === "PUT", intent?.operation);
    const fr = await recordsKv.get(recordAtomicKey(RETIREMENT_FRONTIER, [wedge.uid]));
    check("THE CRASH WINDOW: the frontier record precedes the gate terminal (as a crash after step 8 leaves)",
      fr !== null && fr.operation === "PUT", fr?.operation);
    // The wedge consequence is REAL, not a state read: a same-name respawn — the production
    // spawn path's first write — is REFUSED while the head is `retiring` (SPEC 13.1: a retiring
    // alias is NOT replaceable). On the gate-only predicate this refusal is permanent.
    const respawnMsg = await rejects(() => activateLifecycleAtUid(wreg, { owner: OWNER, actor: A, lifecycleUid: mintLifecycleUid(), managerInstance: "smoke" }));
    check("REPRO: the wedge REFUSES a same-name respawn (a retiring alias is not replaceable, SPEC 13.1)",
      respawnMsg.includes("retiring") && respawnMsg.includes("not replaceable"), respawnMsg);
    // And a stranger's opId may not resume the wedged op (owed-ness never widens to foreign ops).
    const strangerMsg = await rejects(() => resumeAgentRetirement(wreg, mintLifecycleUid(), { evictPrincipal: okEvictor([]), drainTargetObligations: unreached("drain"), openCleaner: unreached("openCleaner"), retireCleanerCredential: unreached("rcc"), openExecutor: unreached("oe"), retireExecutorCredential: unreached("rec"), now: Date.now }));
    check("NEITHER TRIGGER replays a foreign op: a stranger's opId has nothing to resume (not-found)",
      strangerMsg.includes("not-found") || strangerMsg.toLowerCase().includes("nothing to resume"), strangerMsg.slice(0, 160));
  }

  // =================================================================================================
  console.log("B. TRIGGER A: the next auth boot repairs the wedge through the SAME executor");
  {
    const bootLines: string[] = [];
    const bootEvicted: string[] = [];
    plane = await bootPlane({ log: (l) => bootLines.push(l), evictor: okEvictor(bootEvicted) });
    const head = await readLifecycleHeadForOperation(wreg, OWNER, A);
    check("TRIGGER A REPAIRS: the boot resumed the intent and completed the head terminal (`retired`)",
      head?.mapping.state === "retired", head?.mapping);
    check("TRIGGER A is the SAME executor (the barrier's resume, logged with this op's id — the skip is no longer silent)",
      bootLines.some((l) => l.includes(`resumed retirement ${wedge.op}`)), bootLines.filter((l) => l.includes(wedge.op)));
    const gate = await observeGate(wreg, wedge.uid);
    check("…and the gate stays terminal `retired` by the op (a retirement never reopens)",
      gate?.row.state === "retired" && gate.row.op?.opId === wedge.op, gate?.row);
    check("…and the resume is the TAIL ONLY (nothing re-revoked, nothing re-evicted, nothing re-drained past the gate terminal)",
      bootLines.some((l) => l.includes(`resumed retirement ${wedge.op}`) && l.includes("0 row(s) revoked") && l.includes("0 principal(s) verified-evicted") && l.includes("0 endpoint(s) drained")), bootLines.filter((l) => l.includes(wedge.op)));
    // THE PUBLIC SEAM: the plane's production issuance surface (mintConnectCredential, what a
    // successor's exchange calls to mint its root credential) now mints the same-name successor —
    // the exact interface a real respawn hits. On the gate-only predicate this refusal is where
    // an operator meets the wedge.
    const successorCred = await rejects(() => plane.mintConnectCredential({ owner: OWNER, actor: A, lifecycleUid: mintLifecycleUid() }));
    check("…and the freed alias MINTS a same-name successor through the plane's public issuance seam",
      successorCred === "", successorCred.slice(0, 200));

    // THE COMPLETED CELL STAYS SKIPPED: the successor mint just advanced the alias head to a NEW
    // uid at `active` while wedge.op's durable intent (gate retired + its own head terminal
    // landed) remains — exactly the leftover-intent shape of every completed operation. A boot
    // over this state must resume NOTHING for this op (a successor's head means completed).
    const lines2: string[] = [];
    const plane2 = await bootPlane({ log: (l) => lines2.push(l), evictor: okEvictor([]) });
    await plane2.close();
    check("the COMPLETED cell stays skipped: a boot over gate retired + a successor's active head resumes nothing",
      !lines2.some((l) => l.includes(wedge.op)), lines2.filter((l) => l.includes(wedge.op)));
    // Keep ONE plane open from here: the rail's trigger needs a live serving plane, and staging
    // wedge B with no plane open would let the NEXT boot's resume (trigger A) consume it first.
    plane = await bootPlane({ evictor: okEvictor([]) });
  }

  // =================================================================================================
  console.log("C. TRIGGER B: a same-op re-request through the REAL retire-lifecycle rail repairs an independently staged wedge");
  {
    // Staged while the plane above is ALREADY SERVING (no boot intervenes), so the only repair
    // path in play is the rail's own re-entry — an independent second wedge, not a re-run of A.
    const B = "workerB";
    const wedgeB = await stageWedge(B);
    const headBefore = await readLifecycleHeadForOperation(wreg, OWNER, B);
    check("TRIGGER B pre-state: the second wedge is the same crash window (gate retired, head retiring)",
      headBefore?.mapping.state === "retiring" && (await observeGate(wreg, wedgeB.uid))?.row.state === "retired", headBefore?.mapping);
    const r = await railRequest(MGR, { owner: OWNER, actor: B, lifecycleUid: wedgeB.uid }, { opId: wedgeB.op });
    check("TRIGGER B REPAIRS: the rail's same-op re-request answers retired:true through the real plane",
      r !== "no-reply" && r.ok === true && (r.data as { retired?: boolean })?.retired === true, r);
    const head = await readLifecycleHeadForOperation(wreg, OWNER, B);
    check("…and the head lands `retired` (the rail re-entered the SAME barrier; its gate-retired branch finished the tail)",
      head?.mapping.state === "retired", head?.mapping);
    const successorCred = await rejects(() => plane!.mintConnectCredential({ owner: OWNER, actor: B, lifecycleUid: mintLifecycleUid() }));
    check("…and the freed alias MINTS a same-name successor through the public issuance seam",
      successorCred === "", successorCred.slice(0, 200));
  }

  console.log(`\nRETIREMENT-WEDGE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await writer?.close().catch(() => {});
  srv.kill("SIGKILL"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
  process.exit(process.exitCode ?? 0); // a drained-but-open connection must never hang the suite
}
