/**
 * #2070: the host's loopback door that retires a MANAGED lifecycle once its remote manager is gone.
 * The door's plane method (`retireManagedLifecycle`) is driven over a REAL JWT broker and the REAL
 * authority plane; the HTTP guards and the public-face 404 live in remote-exchange.smoke.ts, which
 * runs the real daemon.
 *
 * A. the revoked-grant precondition: a managed row still granted AT THIS uid refuses (conflict) and
 *    leaves the head untouched; a row at a DIFFERENT uid does not block.
 * B. the head outcome table: absent → notStarted; active here → retired (head retired, gate retired,
 *    no connect credential mints at that uid); repeat → alreadyRetired; active at another uid →
 *    conflict; retired at another uid → notStarted.
 * C. crash resume: a barrier that aborted mid-flight under `managedRetirementOpId(uid)` (gate frozen
 *    by that op, head retiring) is FINISHED by the door, because the door re-enters the same op.
 * D. one operation, one flight: the door and the participant rail, racing for the same uid, run ONE
 *    barrier execution (the evictor runs once) and both answer success.
 *
 * Run: pnpm smoke:managed-retire-door:auth   (needs nats-server on PATH)
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
  AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, epgateKey, epAuthBucket, epfStreamName, epwStreamName,
  epRequestSubject, epCallerReplyFilter, parseEpSubject, EpEnvelopeError,
  createEndpointStreams, createSpaceAuth, ensureAuthorityStores, isReachable, DEV_OWNER,
  mintCreds, managedRetirementOpId, mintLifecycleUid, newIdentity, principalKey, serverConfig, type EvictionResult,
} from "@cotal-ai/core";
import { deriveOwnerToken, grantManagedActor, newActorToken, openAuthAuthorityPlane, revokeManagedActor } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { observeGate, openLifecycleRegistry, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import { runAgentRetirementBarrier, type RetirementDeps } from "../src/retirement-barrier.js";
import type { EvictPrincipal } from "../src/credential-ledger.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const outcome = async <T>(fn: () => Promise<T>): Promise<{ value?: T; code?: string; message?: string }> => {
  try { return { value: await fn() }; } catch (e) {
    return { code: e instanceof EpEnvelopeError ? e.code : "thrown", message: e instanceof Error ? e.message : String(e) };
  }
};

const space = `mret-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
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
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};

// Every eviction is RECORDED. One barrier execution evicts the target principal exactly once (plus
// its own per-op repair principals), so target evictions count barrier executions. The first
// eviction after arming PARKS, so a racing request provably arrives while that barrier is in flight.
const evicted: string[] = [];
const targetEvictions = (actor: string) => evicted.filter((p) => p === `${OWNER}.${actor}`).length;
let gateArmed = false;
let gateEntered: (() => void) | undefined;
let gateRelease: (() => void) | undefined;
const countingEvictor: EvictPrincipal = async (principal) => {
  evicted.push(principal);
  if (gateArmed) {
    gateArmed = false;
    gateEntered?.();
    await new Promise<void>((res) => { gateRelease = res; });
  }
  return { principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult;
};

const MGR_SERVE = newIdentity();
const MGR = { owner: DEV_OWNER, actor: MGR_SERVE.id, uid: mintLifecycleUid() };
const MGR_INST = mintLifecycleUid();
const SERVE_EPOCH = 1;

/** One participant rail request (the late manager's path), exactly as auth-admin.smoke.ts sends it. */
async function railRequest(target: { owner: string; actor: string; lifecycleUid: string }): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string } | "no-reply"> {
  const creds = await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: { ...MGR, target } });
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
  const nonce = randomUUID().replace(/-/g, "") + "aaaaaaaa";
  try {
    const subject = epRequestSubject(space, {
      route: { mode: "one" }, endpoint: AUTH_ENDPOINT, command: EP_CMD_RETIRE_LIFECYCLE,
      target: { mode: "handle", tOwner: target.owner, tActor: target.actor, tUid: target.lifecycleUid },
      caller: MGR, nonce,
    });
    const requestId = randomUUID().replace(/-/g, "");
    let settle: (v: { ok: boolean; data?: Record<string, unknown>; error?: string } | "no-reply") => void;
    const got = new Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string } | "no-reply">((res) => { settle = res; });
    const sub = nc.subscribe(epCallerReplyFilter(space, MGR), {
      callback: (err, msg) => {
        if (err) return;
        const parsed = parseEpSubject(msg.subject);
        if (!parsed || parsed.plane !== "reply" || parsed.endpoint !== AUTH_ENDPOINT || parsed.nonce !== nonce) return;
        let body: { ok: boolean; id?: unknown; data?: Record<string, unknown>; error?: string };
        try { body = JSON.parse(new TextDecoder().decode(msg.data)) as typeof body; } catch { return; }
        if (body.id !== requestId) return;
        settle(body);
      },
    });
    const timer = setTimeout(() => settle("no-reply"), 15000);
    const args = { serveEndpoint: "manager", serveInstanceId: MGR_INST, serveEpoch: SERVE_EPOCH, opId: managedRetirementOpId(target.lifecycleUid) };
    nc.publish(subject, new TextEncoder().encode(JSON.stringify({ id: requestId, op: "retireLifecycle", args })));
    const out = await got;
    clearTimeout(timer);
    try { sub.unsubscribe(); } catch { /* down */ }
    return out;
  } finally {
    await nc.close().catch(() => {});
  }
}

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
  await epKv.put(epgateKey("manager", MGR_INST), new TextEncoder().encode(JSON.stringify(
    { state: "open", generation: 1, processEpoch: SERVE_EPOCH, registrationRevision: 1, nameAuthorityRevision: 1, principal: principalKey(DEV_OWNER, MGR_SERVE.id).key })));

  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet, probeEvictor: countingEvictor });
  const wreg = await openLifecycleRegistry(wide.nc, space);
  const door = (actor: string, lifecycleUid: string) => outcome(() => plane!.retireManagedLifecycle({ owner: OWNER, actor, lifecycleUid }));
  const grant = (actor: string, lifecycleUid: string) => grantManagedActor(dir, {
    owner: OWNER, actor, scope: [], allowSubscribe: [], allowPublish: [], tokenHash: newActorToken().tokenHash, lifecycleUid,
  });
  const live = async (actor: string): Promise<string> => {
    const uid = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor, lifecycleUid: uid, managerInstance: "smoke" });
    return uid;
  };
  const headOf = async (actor: string) => (await readLifecycleHeadForOperation(wreg, OWNER, actor))?.mapping;

  console.log("A. the revoked-grant precondition");
  {
    const uid = await live("wgranted");
    grant("wgranted", uid);
    const r = await door("wgranted", uid);
    check("a managed grant still live AT THIS uid refuses with conflict (revoke first)",
      r.code === "conflict" && /still granted/.test(r.message ?? ""), r);
    check("...and the refusal left the head active at that uid",
      (await headOf("wgranted"))?.state === "active" && (await headOf("wgranted"))?.lifecycleUid === uid);
    revokeManagedActor(dir, OWNER, "wgranted");
    const after = await door("wgranted", uid);
    check("INVERSE CONTROL: the same call after revoking the grant retires it",
      after.value?.retired === true && (await headOf("wgranted"))?.state === "retired", after);

    const uidOld = await live("wsucc");
    grant("wsucc", mintLifecycleUid()); // a successor row at ANOTHER uid
    const succ = await door("wsucc", uidOld);
    check("a managed row at a DIFFERENT uid does not block; the head decides (retired here)",
      succ.value?.retired === true && (await headOf("wsucc"))?.state === "retired", succ);
    revokeManagedActor(dir, OWNER, "wsucc");
  }

  console.log("B. the head outcome table");
  {
    const absent = await door("wnever", mintLifecycleUid());
    check("no head → notStarted, retired:false", absent.value?.notStarted === true && absent.value.retired === false, absent);

    const uid = await live("wlive");
    const r = await door("wlive", uid);
    check("head active at this uid → retired:true", r.value?.retired === true && r.value.lifecycleUid === uid && r.value.notStarted === undefined, r);
    check("...the head is retired", (await headOf("wlive"))?.state === "retired");
    check("...the issuance gate is retired by the managed operation id",
      (await observeGate(wreg, uid))?.row.state === "retired" && (await observeGate(wreg, uid))?.row.op?.opId === managedRetirementOpId(uid),
      (await observeGate(wreg, uid))?.row);
    check("...the barrier really ran (the target principal was evicted once)", targetEvictions("wlive") === 1, evicted);
    const mint = await outcome(() => plane!.mintConnectCredential({ owner: OWNER, actor: "wlive", lifecycleUid: uid }));
    check("...and no connect credential mints at the retired uid", mint.code !== undefined, mint);
    const again = await door("wlive", uid);
    check("a repeat call → alreadyRetired", again.value?.alreadyRetired === true && again.value.retired === true, again);

    const uidOther = await live("wother");
    const conflict = await door("wother", mintLifecycleUid());
    check("head active at ANOTHER uid → conflict", conflict.code === "conflict", conflict);
    check("...and that head is untouched", (await headOf("wother"))?.state === "active" && (await headOf("wother"))?.lifecycleUid === uidOther);

    const uidRetired = await live("wprev");
    await door("wprev", uidRetired);
    const stale = await door("wprev", mintLifecycleUid());
    check("head retired at ANOTHER uid → notStarted", stale.value?.notStarted === true && stale.value.retired === false, stale);
  }

  console.log("C. crash resume: the door finishes a barrier that aborted under the managed operation id");
  {
    const uid = await live("wcrash");
    const failing: RetirementDeps = {
      evictPrincipal: async (principal) => ({ principal, kicked: 0, remaining: 1, verifiedGone: false, scanComplete: true, note: "staged crash" }),
      drainTargetObligations: async () => { throw new Error("unreached"); },
      openCleaner: async () => { throw new Error("unreached"); }, retireCleanerCredential: async () => { throw new Error("unreached"); },
      openExecutor: async () => { throw new Error("unreached"); }, retireExecutorCredential: async () => { throw new Error("unreached"); },
      now: Date.now,
    };
    const aborted = await outcome(() => runAgentRetirementBarrier(wreg, {
      owner: OWNER, actor: "wcrash", lifecycleUid: uid, opId: managedRetirementOpId(uid),
      frontierStreams: [epfStreamName(space), epwStreamName(space)],
    }, failing));
    const gate = (await observeGate(wreg, uid))?.row;
    check("STAGED: the barrier aborted with the gate frozen by the managed op and the head retiring",
      aborted.code !== undefined && gate?.state === "frozen" && gate.op?.opId === managedRetirementOpId(uid) && (await headOf("wcrash"))?.state === "retiring",
      { aborted, gate, head: await headOf("wcrash") });
    const r = await door("wcrash", uid);
    check("the door re-enters the SAME operation and finishes it (retired:true, head retired)",
      r.value?.retired === true && (await headOf("wcrash"))?.state === "retired", r);
  }

  console.log("D. one operation, one flight: the door and the participant rail race for one uid");
  {
    const uid = await live("wrace");
    const entered = new Promise<void>((res) => { gateEntered = res; });
    gateArmed = true;
    const doorP = door("wrace", uid);
    let parked = true;
    await Promise.race([entered, wait(8000).then(() => { parked = false; })]);
    check("the door's barrier parked in eviction (the race window is real)", parked);
    const railP = railRequest({ owner: OWNER, actor: "wrace", lifecycleUid: uid });
    await wait(1500); // the rail request is now inside the plane; a separate flight would evict here
    const evWhileParked = targetEvictions("wrace");
    gateArmed = false;
    gateRelease?.();
    const [d, rl] = await Promise.all([doorP, railP]);
    check("while the door is parked, the rail request starts NO second barrier (one target eviction so far)", evWhileParked === 1, { evWhileParked });
    check("the door answers retired", d.value?.retired === true, d);
    check("the rail answers success (retired or alreadyRetired) on the same operation",
      rl !== "no-reply" && rl.ok === true && ((rl.data as { retired?: boolean })?.retired === true || (rl.data as { alreadyRetired?: boolean })?.alreadyRetired === true), rl);
    check("exactly one barrier execution ran for this uid (the target was evicted once)", targetEvictions("wrace") === 1, { targetEvictions: targetEvictions("wrace") });
    check("...under managedRetirementOpId(uid)", (await observeGate(wreg, uid))?.row.op?.opId === managedRetirementOpId(uid));
  }
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  gateRelease?.();
  await plane?.close().catch(() => {});
  await wide?.close().catch(() => {});
  srv.kill("SIGTERM"); // exact PID - never pkill nats-server
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
}
// Counts, not just "no failures": a cell that stops running stops protecting anything.
const EXPECTED = 22;
console.log(`\nMANAGED-RETIRE-DOOR SMOKE ${fail === 0 && pass + fail === EXPECTED ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed, expected ${EXPECTED})`);
process.exit(fail === 0 && pass + fail === EXPECTED ? 0 : 1);
