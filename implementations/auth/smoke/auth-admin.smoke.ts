/**
 * #29 piece 3 — the AUTH ENDPOINT RAIL smoke (Cotal #350: the rail moved off the retired `ctl`
 * surface onto `ep.one.auth`): the despawn→retirement trigger's serve side, proven over a REAL JWT
 * broker + the REAL authority plane.
 *
 * A. the requester credential's broker-enforced confinement: it can publish ONLY its own
 *    control subject (a foreign principal's subject is broker-denied), and only its own reply
 *    subtree is readable.
 * B. the GREEN path: a CURRENT serving manager instance's request retires a live lifecycle end-to-end
 *    through the plane's own barrier + sealed scanner; a REPEAT request answers already-retired
 *    (idempotent, same stable opId).
 * C. the RAIL-TIME serve-grant re-check (P2 item 3 3b-3, registration-record-derived): a SUPERSEDED
 *    manager instance (old serve epoch, a deposed predecessor after a restart) is refused with the
 *    full-no-op copy (`cotal supervise` NEXT, and the target provably unchanged); an ABSENT serve
 *    registration refuses fail-closed; a STALE uid
 *    refuses naming the current incarnation; a BOGUS reply header is INERT (the responder derives
 *    the reply from the parsed request, so the confused-deputy boundary is structural).
 * D. THE FOREIGN-INSTANCE CELL: a caller naming a serve registration owned by a DIFFERENT
 *    principal is refused BY THE PRINCIPAL CROSS-CHECK — pre-cut the rail accepted any registered
 *    instance's gate, so this was ADMITTED — with the own-registration inverse control. (A foreign-op-holds-the-gate refusal is exercised where
 *    gates are staged — the retirement-barrier suite; the rail branch is exact-code over the
 *    same observeGate read.)
 *
 * Run: pnpm smoke:auth-admin:auth   (needs nats-server on PATH)
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
  AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, epgateKey, epAuthBucket,
  epRequestSubject, epCallerReplyFilter, parseEpSubject,
  createEndpointStreams, createSpaceAuth, ensureAuthorityStores, isReachable, DEV_OWNER,
  mintCreds, mintLifecycleUid, newIdentity, principalKey, serverConfig, type EvictionResult,
} from "@cotal-ai/core";
import { deriveOwnerToken, openAuthAuthorityPlane } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { authAdminListenerGrants } from "../src/auth-admin.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { openLifecycleRegistry, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import type { EvictPrincipal } from "../src/credential-ledger.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `aadm-${randomUUID().slice(0, 8)}`;
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
const okEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult);
// A GATED evictor for phase E: when armed, the first eviction call parks (holding that retirement's
// barrier flight live in `barrierFlight`) until released — so a second same-opId request provably
// arrives while the first is still in flight. Pass-through (== okEvictor) whenever the gate is idle,
// so phases A-D are unaffected.
let gateArmed = false;
let gateEntered: (() => void) | null = null;
let gateRelease: (() => void) | null = null;
const gatedEvictor: EvictPrincipal = async (principal) => {
  if (gateArmed) {
    gateArmed = false; // only the first call after arming gates
    gateEntered?.();
    await new Promise<void>((res) => { gateRelease = res; });
  }
  return okEvictor(principal);
};
// A manager holds TWO real identities, and Cotal #549 was the two being conflated: the nkey it
// REGISTERS with (what its serve gate is bound to) and the nkey its ENDPOINT connects with. The
// fixture models both, and derives each side of the rail's cross-check through the same expression
// production uses on that side, from a different input. It used to spend ONE friendly literal on
// both halves, so the cross-check was asserted against an equality this file had itself written:
// a shape that cannot fail, teaches nothing, and let #549 through.
const MGR_SERVE = newIdentity(); // registered; `gate.principal` is bound to this one
const MGR_ENDPOINT = newIdentity(); // the endpoint's connection identity, never an authorization
const MGR = { owner: DEV_OWNER, actor: MGR_SERVE.id, uid: mintLifecycleUid() };
const spacePrefixLiteral = `cotal.${space}`;
const MGR_KEY = principalKey(DEV_OWNER, MGR_SERVE.id).key;
// P2 item 3 (3b-3): the rail's holder check is now the serve-issuance GATE, not the manager lease.
// The requester declares its serve identity; these are the defaults every green request rides (a test
// overrides serveEpoch to model a superseded/deposed predecessor).
const MGR_INST = mintLifecycleUid();
const SERVE_EPOCH = 1;

/** One rail request over a FRESH requester credential (the real mint + real broker ACLs). The
 *  default serve identity (manager/MGR_INST @ SERVE_EPOCH) is injected; caller `args` override it.
 *
 *  REPLY DIRECTION: on the `ep` rail the RESPONDER derives the reply subject and prefixes its OWN
 *  instance id, so a caller-supplied `reply` header is ignored and `nc.request` can never receive
 *  the answer. The caller subscribes its own reply-plane filter and binds off the reply SUBJECT
 *  (endpoint + nonce, both broker-pinned by the responder's serve grant) - `endpoint-invoke.ts`. */
async function request(
  caller: { owner: string; actor: string; uid: string },
  target: { owner: string; actor: string; lifecycleUid: string },
  args: Record<string, unknown> = {},
  opts: { bogusReplyHeader?: boolean; wrongEchoProbe?: boolean } = {},
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
      callback: (err, msg) => {
        if (err) return;
        const parsed = parseEpSubject(msg.subject);
        if (!parsed || parsed.plane !== "reply" || parsed.endpoint !== AUTH_ENDPOINT || parsed.nonce !== nonce) return;
        let body: { ok: boolean; id?: unknown; data?: Record<string, unknown>; error?: string };
        try { body = JSON.parse(new TextDecoder().decode(msg.data)) as typeof body; } catch { return; }
        // Mirrors the production caller: the reply MUST echo our request id. `wrongEchoProbe`
        // demands a DIFFERENT id, so a correct responder's answer is correctly ignored - which is
        // how the cell proves the echo is load-bearing rather than decorative.
        if (body.id !== (opts.wrongEchoProbe ? `${requestId}-WRONG` : requestId)) return;
        settle(body);
      },
    });
    const timer = setTimeout(() => settle("no-reply"), 8000);
    // A BOGUS reply header models the pre-cut "caller-selected reply target": on `ep` it must be
    // inert - the responder never reads it.
    nc.publish(subject, new TextEncoder().encode(JSON.stringify({ id: requestId, op: "retireLifecycle", args: fullArgs })),
      opts.bogusReplyHeader ? { reply: `${spacePrefixLiteral}.ep.reply.auth.${"z".repeat(26)}.0.local.other.${"z".repeat(26)}.${nonce}` } : undefined);
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
  // P2 item 3 (3b-3): the rail reads the serve-issuance GATE (`epgate.manager.<instanceId>`), a
  // registration-record-derived currency check, not the per-space manager lease. Stage a gate row for
  // the manager instance at a given serve epoch (a superseded predecessor declares an OLD epoch and is
  // refused). `createEndpointStreams` pre-created the epAuth bucket the gate lives in.
  const epKv = await kvm.open(epAuthBucket(space));
  const putGate = async (instanceId: string, epoch: number, state: "open" | "retired" = "open") => {
    const row: Record<string, unknown> = { state, generation: 1, processEpoch: epoch, registrationRevision: 1, nameAuthorityRevision: 1, principal: MGR_KEY };
    if (state === "retired") row.op = { opId: "r".repeat(26), kind: "retirement" };
    await epKv.put(epgateKey("manager", instanceId), new TextEncoder().encode(JSON.stringify(row)));
  };
  await putGate(MGR_INST, SERVE_EPOCH);

  // The REAL plane serves the rail.
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet, probeEvictor: gatedEvictor });
  const wreg = await openLifecycleRegistry(wide.nc, space);

  console.log("A. requester-credential confinement (broker ACLs)");
  {
    const pinnedTarget = { owner: OWNER, actor: "wpin", lifecycleUid: mintLifecycleUid() };
    const creds = await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: { ...MGR, target: pinnedTarget } });
    const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
    // A denied publish does NOT throw: nats-server reports a permissions violation ASYNCHRONOUSLY
    // on the status channel. Asserting on a thrown error would make these cells vacuous - they
    // would pass whether or not the broker denied anything. Collect the violations and assert the
    // SUBJECT that was refused, so the cell names WHICH denial it observed.
    const violations: string[] = [];
    void (async () => { try { for await (const st of nc.status()) violations.push(JSON.stringify(st)); } catch { /* closed */ } })();
    const deniedFor = async (subject: string): Promise<boolean> => {
      violations.length = 0;
      nc.publish(subject, new TextEncoder().encode("{}"));
      try { await nc.flush(); } catch { /* the violation may close the flush */ }
      await wait(400);
      return violations.some((v) => /permission/i.test(v) && v.includes(subject));
    };
    try {
      // A FOREIGN CALLER TRIPLE: the subject's caller block IS the attribution, and the grant pins
      // it, so publishing as someone else is refused by the broker - it never reaches the handler.
      const foreignCaller = epRequestSubject(space, {
        route: { mode: "one" }, endpoint: AUTH_ENDPOINT, command: EP_CMD_RETIRE_LIFECYCLE,
        target: { mode: "handle", tOwner: pinnedTarget.owner, tActor: pinnedTarget.actor, tUid: pinnedTarget.lifecycleUid },
        caller: { owner: "local", actor: "other", uid: mintLifecycleUid() }, nonce: "n".repeat(30),
      });
      check("the requester credential CANNOT publish as a FOREIGN caller triple (the broker denies it; attribution is the ACL)",
        await deniedFor(foreignCaller));
      // NEW with #350: the TARGET is grant-pinned too, so a leaked requester cannot be RE-AIMED at
      // another incarnation. The `ctl` grant could not express this - its subject named only the
      // caller, so any target could ride the body.
      const foreignTarget = epRequestSubject(space, {
        route: { mode: "one" }, endpoint: AUTH_ENDPOINT, command: EP_CMD_RETIRE_LIFECYCLE,
        target: { mode: "handle", tOwner: OWNER, tActor: "wother", tUid: mintLifecycleUid() },
        caller: MGR, nonce: "n".repeat(30),
      });
      check("the requester credential CANNOT re-aim at a DIFFERENT incarnation (the handle target is grant-pinned)",
        await deniedFor(foreignTarget));
      // POSITIVE CONTROL: the SAME credential's own pinned subject is NOT denied - without it the
      // two cells above would pass against a credential that cannot publish anything at all.
      const own = epRequestSubject(space, {
        route: { mode: "one" }, endpoint: AUTH_ENDPOINT, command: EP_CMD_RETIRE_LIFECYCLE,
        target: { mode: "handle", tOwner: pinnedTarget.owner, tActor: pinnedTarget.actor, tUid: pinnedTarget.lifecycleUid },
        caller: MGR, nonce: "n".repeat(30),
      });
      check("POSITIVE CONTROL: the credential's OWN pinned subject is NOT denied (the two denials above are the grant, not a dead credential)",
        !(await deniedFor(own)));
    } finally {
      await nc.close().catch(() => {});
    }
  }

  console.log("B. the green path (a current serving instance retires a live lifecycle; repeat = idempotent)");
  const uid1 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "w1", lifecycleUid: uid1, managerInstance: "smoke" });
  const op1 = "a".repeat(26);
  const r1 = await request(MGR, { owner: OWNER, actor: "w1", lifecycleUid: uid1 }, { opId: op1 });
  check("a current serving instance's request RETIRES the lifecycle end-to-end (the plane's own barrier + sealed scanner)",
    r1 !== "no-reply" && r1.ok === true && (r1.data as { retired?: boolean })?.retired === true, r1);
  check("the head reads retired after the rail request",
    (await readLifecycleHeadForOperation(wreg, OWNER, "w1"))?.mapping.state === "retired");
  const r1b = await request(MGR, { owner: OWNER, actor: "w1", lifecycleUid: uid1 }, { opId: op1 });
  check("a REPEAT request answers already-retired (idempotent under the stable opId)",
    r1b !== "no-reply" && r1b.ok === true && (r1b.data as { alreadyRetired?: boolean })?.alreadyRetired === true, r1b);

  console.log("C. the refusal faces (rail-time serve-grant re-check + closed shapes)");
  const uid2 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "w2", lifecycleUid: uid2, managerInstance: "smoke" });
  const op2 = "b".repeat(26);
  // SUPERSEDED (P2 item 3 3b-3 — the red-first deposed-predecessor fence): the gate advanced to a NEWER
  // epoch (a restart re-registered the SAME instanceId), so a request declaring the OLD epoch is a
  // deposed predecessor and is refused. Against the old name-derived lease-holder check this PASSED (the
  // shared holder principal matched); the gate-currency check is what closes it.
  await putGate(MGR_INST, SERVE_EPOCH + 1); // current serve grant is now epoch 2
  const r2 = await request(MGR, { owner: OWNER, actor: "w2", lifecycleUid: uid2 }, { opId: op2, serveEpoch: SERVE_EPOCH }); // predecessor declares epoch 1
  check("a SUPERSEDED manager instance (old epoch) is refused as a full no-op (names SUPERSEDED + the epochs + cotal supervise)",
    r2 !== "no-reply" && r2.ok === false && (r2.error ?? "").includes("SUPERSEDED") && (r2.error ?? "").includes("FULL no-op") && (r2.error ?? "").includes("cotal supervise"), r2);
  check("the refused target is provably UNCHANGED (the full-no-op statement is true)",
    (await readLifecycleHeadForOperation(wreg, OWNER, "w2"))?.mapping.state === "active");
  // ABSENT registration: the requester names an instance with NO serve gate (never registered). A real
  // gate is never DELETED (a DEL is corruption, SPEC 13.12), so absence is an unregistered instanceId.
  const r3 = await request(MGR, { owner: OWNER, actor: "w2", lifecycleUid: uid2 }, { opId: op2, serveInstanceId: mintLifecycleUid() });
  check("an ABSENT serve registration refuses fail-closed (no manager instance holds; supervise NEXT)",
    r3 !== "no-reply" && r3.ok === false && (r3.error ?? "").includes("no manager instance currently holds") && (r3.error ?? "").includes("cotal supervise"), r3);
  await putGate(MGR_INST, SERVE_EPOCH); // restore the current gate at the default epoch (the superseded test bumped it) for the stale-uid test below
  // Stale uid: the trigger names a previous incarnation.
  const r4 = await request(MGR, { owner: OWNER, actor: "w2", lifecycleUid: mintLifecycleUid() }, { opId: op2 });
  check("a STALE incarnation refuses naming the current one (never retires the wrong lifecycle)",
    r4 !== "no-reply" && r4.ok === false && (r4.error ?? "").includes("stale incarnation") && (r4.error ?? "").includes(uid2), r4);
  // RE-POINTED (#350), not deleted. On `ctl` the caller CHOSE its reply target, so the listener had
  // to refuse an unbound one by inspecting `msg.reply` - a check that could be forgotten. On `ep`
  // the responder DERIVES the reply from the parsed request, so a caller-supplied header is inert
  // by construction. The cell therefore asserts the NEW guarantee: a bogus reply header changes
  // nothing - the answer still arrives on the derived subject, and it is a REAL answer.
  {
    const uidRep = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor: "wrep", lifecycleUid: uidRep, managerInstance: "smoke" });
    const rRep = await request(MGR, { owner: OWNER, actor: "wrep", lifecycleUid: uidRep }, { opId: "p".repeat(26) }, { bogusReplyHeader: true });
    check("a BOGUS reply header is INERT: the reply still arrives on the DERIVED subject (the confused-deputy boundary is structural, not a check)",
      rRep !== "no-reply" && rRep.ok === true && (rRep.data as { retired?: boolean })?.retired === true, rRep);
  }

  // ---- THE CLASS-RAIL QUEUE QUALIFICATION, PROVEN LIVE ON THE BROKER ---------------------------
  // The listener grant is the NATS `"<subject> <queue>"` form. Its whole point is that NO credential
  // may PLAIN-subscribe the class rail: a plain subscriber sees EVERY request's nonce, and nonce
  // possession is what confines addressing on the reply plane. The matrix audit asserts the grant
  // STRING; this asserts the BROKER enforces it - the two are different claims, and the string one
  // was vacuous for a while (it asserted a plain row while its name said queue-qualified).
  console.log("E. class-rail queue qualification (live broker enforcement)");
  {
    const RESP = { instanceId: mintLifecycleUid(), epoch: 0 };
    const lc = await openAuthorityClient({
      server: SERVERS, space, dataAccount, label: `listener-probe:${space}`,
      grants: (id) => authAdminListenerGrants(space, id, RESP), log: quiet,
    });
    try {
      const violations: string[] = [];
      void (async () => { try { for await (const st of lc.nc.status()) violations.push(JSON.stringify(st)); } catch { /* closed */ } })();
      const rail = `cotal.${space}.ep.one.auth.retire-lifecycle.>`;
      // PLAIN subscribe - must be denied by the broker.
      violations.length = 0;
      const plain = lc.nc.subscribe(rail);
      try { await lc.nc.flush(); } catch { /* the violation may close the flush */ }
      await wait(400);
      const deniedPlain = violations.some((v) => /permission/i.test(v) && v.includes("ep.one.auth.retire-lifecycle"));
      try { plain.unsubscribe(); } catch { /* already dead */ }
      check("a PLAIN subscribe of the class rail is DENIED BY THE BROKER (a plain subscriber would see every request's nonce)", deniedPlain);
      // POSITIVE CONTROL: the SAME credential's QUEUE subscribe is allowed - without this the cell
      // above passes against a credential that cannot subscribe anything at all.
      violations.length = 0;
      const queued = lc.nc.subscribe(rail, { queue: "auth" });
      try { await lc.nc.flush(); } catch { /* nothing expected */ }
      await wait(400);
      const deniedQueued = violations.some((v) => /permission/i.test(v) && v.includes("ep.one.auth.retire-lifecycle"));
      try { queued.unsubscribe(); } catch { /* already dead */ }
      check("POSITIVE CONTROL: the SAME credential's QUEUE-qualified subscribe is ALLOWED (the denial above is the queue rule, not a dead credential)", !deniedQueued);
    } finally {
      await lc.close().catch(() => {});
    }
  }

  // ---- THE ID-ECHO CELL: the minimal correctness guard from the un-migrated envelope ----------
  // The rail moved to `ep` SUBJECTS but still exchanges the ctl-era `{op,args}`/`{ok,data,error}`
  // bodies (SPEC 1421 says those envelopes are DELETED - a NAMED RESIDUAL, its own cut). Binding a
  // reply on (endpoint, nonce) alone would let a malformed or WRONG-ID `{ok:true}` clear a
  // retirement hold, so the reply MUST echo the caller's request id.
  {
    const uidE = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor: "wecho", lifecycleUid: uidE, managerInstance: "smoke" });
    // POSITIVE CONTROL FIRST, on a lifecycle we then leave alone: the normal path answers.
    const uidE2 = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor: "wecho2", lifecycleUid: uidE2, managerInstance: "smoke" });
    const rOk = await request(MGR, { owner: OWNER, actor: "wecho2", lifecycleUid: uidE2 }, { opId: "e".repeat(26) });
    check("POSITIVE CONTROL: a reply whose id ECHOES the request is accepted (the cell is not passing by never answering)",
      rOk !== "no-reply" && rOk.ok === true, rOk);
    // Now demand an id the responder will never send. The responder answers correctly; the caller
    // must REFUSE that answer. A cell that only asserted "no reply" would pass against a dead rail,
    // so the head is checked too: the retirement DID happen server-side, and was still not accepted.
    const rWrong = await request(MGR, { owner: OWNER, actor: "wecho", lifecycleUid: uidE }, { opId: "g".repeat(26) }, { wrongEchoProbe: true });
    check("a reply whose id does NOT echo the request is REFUSED by the caller (a wrong-id ok:true cannot clear a hold)",
      rWrong === "no-reply", rWrong);
    check("...and the refusal is the CALLER's, not a dead rail: the responder DID process it (the head reads retired)",
      (await readLifecycleHeadForOperation(wreg, OWNER, "wecho"))?.mapping.state === "retired");
  }

  // ---- THE FOREIGN-INSTANCE CELL (#350) - the kill cell for the authz tightening ----------------
  // It REPLACES the recycled-alias cell that was originally planned: that cell would have graded a
  // mechanism the tree does not have (the rail never compared an alias against a lease), and its
  // assertion would have been FALSE under the real one - a recycled alias still passes a principal
  // cross-check, because that is what an alias IS.
  //
  // What genuinely inverts across this cut: a caller naming a serve registration that belongs to a
  // DIFFERENT principal. PRE-CUT the rail accepted ANY registered instance's gate ("accept any
  // registered instance with a current serve grant"), so this was ADMITTED. POST-CUT the principal
  // cross-check refuses it. This is a state the rail's own writer cannot produce by accident.
  console.log("D. the foreign-instance cell (the principal cross-check)");
  {
    const uidF = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor: "wforeign", lifecycleUid: uidF, managerInstance: "smoke" });
    // A registration owned by SOMEONE ELSE, current and open at the declared epoch - so the only
    // thing that can refuse it is the principal comparison, not currency and not arity.
    const foreignInst = mintLifecycleUid();
    await epKv.put(epgateKey("manager", foreignInst), new TextEncoder().encode(JSON.stringify(
      { state: "open", generation: 1, processEpoch: SERVE_EPOCH, registrationRevision: 1, nameAuthorityRevision: 1, principal: "local.someoneelse" })));
    const rF = await request(MGR, { owner: OWNER, actor: "wforeign", lifecycleUid: uidF }, { opId: "f".repeat(26), serveInstanceId: foreignInst });
    // WHICH refusal, by name: the principal cross-check - not a grammar rejection, not an arity
    // mismatch, not a no-responder timeout, each of which would satisfy a naive "it was refused".
    check("a caller naming a FOREIGN principal's serve registration is REFUSED BY THE PRINCIPAL CROSS-CHECK (pre-cut this was ADMITTED)",
      rF !== "no-reply" && rF.ok === false
      && /belongs to local\.someoneelse/.test(rF.error ?? "") && /not to the requesting principal/.test(rF.error ?? "")
      && /FULL no-op/.test(rF.error ?? ""), rF);
    check("...and the refusal is a COMPLETE no-op: the target lifecycle is still active",
      (await readLifecycleHeadForOperation(wreg, OWNER, "wforeign"))?.mapping.state === "active");
    // INVERSE CONTROL: without it, the cell above is satisfied by a rail that refuses EVERYTHING.
    const rOwn = await request(MGR, { owner: OWNER, actor: "wforeign", lifecycleUid: uidF }, { opId: "f".repeat(26) });
    check("INVERSE CONTROL: the SAME caller naming its OWN serve registration SUCCEEDS (the cell grades the principal comparison, not a rail that refuses everything)",
      rOwn !== "no-reply" && rOwn.ok === true && (rOwn.data as { retired?: boolean })?.retired === true, rOwn);
  }
  // THE DIVERGENCE GUARD (Cotal #549). The cell above uses a foreign party, which reads as an
  // outsider and is easy to get right. #549 was the hard shape: ONE manager process, TWO of its own
  // real identities, and the requester speaking as the wrong one of them. Nothing about that looks
  // like an intruder, which is why it survived every existing cell and shipped as "no user-mesh
  // retirement ever completes". The registered identity authorizes; a second identity of the SAME
  // process does not, whatever else it is entitled to do.
  //
  // WHAT THIS DOES AND DOES NOT PROVE. It fences the rail's side of the class: after this, a manager
  // that speaks as anything other than its REGISTERED serve identity is refused here, deterministic
  // and named. It cannot be red-before/green-after on its own, because the requester derivation the
  // fix changes lives in the manager and `implementations/*` never import each other; that half is
  // proved end-to-end over the real Manager in `user-spawn.smoke.ts`, with the mutation registered
  // on it. This cell's job is that the FIXTURE can no longer agree with itself.
  console.log("D. the divergence guard (#549: two identities of one manager)");
  {
    const uidD = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor: "wdiverge", lifecycleUid: uidD, managerInstance: "smoke" });
    const target = { owner: OWNER, actor: "wdiverge", lifecycleUid: uidD };
    // Same manager, same live registration, same epoch: the ONLY difference from the green path is
    // which of its own identities the caller triple carries.
    const rEp = await request({ owner: DEV_OWNER, actor: MGR_ENDPOINT.id, uid: MGR.uid }, target, { opId: "d".repeat(26) });
    check("a manager speaking as its ENDPOINT identity is REFUSED against its own serve registration (both principals named, both derived, not literals)",
      rEp !== "no-reply" && rEp.ok === false
      && rEp.error?.includes(MGR_KEY) === true
      && rEp.error?.includes(principalKey(DEV_OWNER, MGR_ENDPOINT.id).key) === true
      && /FULL no-op/.test(rEp.error ?? ""), rEp);
    check("...and that refusal left the target alive (an unauthorized request must not have acted)",
      (await readLifecycleHeadForOperation(wreg, OWNER, "wdiverge"))?.mapping.state === "active");
    // INVERSE CONTROL, on the SAME target and the SAME registration: the SERVE identity is accepted.
    // Without it the cell above is satisfied by a rail that refuses every nkey-shaped principal.
    const rServe = await request(MGR, target, { opId: "d".repeat(26) });
    check("INVERSE CONTROL: the SERVE identity, on the same target and the same registration, IS authorized and retires it",
      rServe !== "no-reply" && rServe.ok === true && (rServe.data as { retired?: boolean })?.retired === true, rServe);
  }
  // And the target is still intact after every refusal above.
  check("after every refusal face the target lifecycle is STILL active (refusals are complete no-ops)",
    (await readLifecycleHeadForOperation(wreg, OWNER, "w2"))?.mapping.state === "active");

  console.log("D. coordinate-bound single-flight (audit #1): a same-opId join for a DIFFERENT lifecycle is a full no-op while the first is in flight, never a false success");
  {
    const uidA = mintLifecycleUid();
    const uidB = mintLifecycleUid();
    await ensureRootCredential(wreg, { owner: OWNER, actor: "wcolla", lifecycleUid: uidA, managerInstance: "smoke" });
    await ensureRootCredential(wreg, { owner: OWNER, actor: "wcollb", lifecycleUid: uidB, managerInstance: "smoke" });
    const shared = "c".repeat(26); // ONE opId, deliberately reused across two DIFFERENT lifecycles
    // Park A's retirement inside its barrier (its flight live in barrierFlight), then fire B with the
    // SAME opId. The overlap is the WHOLE point: the false-join hole only exists while A's promise is
    // live, so gate engagement is MANDATORY — a run that fails to park A must FAIL, never silently
    // weaken to the post-settlement durable-intent fence (which would refuse B even on a broken bind).
    const enteredP = new Promise<void>((res) => { gateEntered = res; });
    gateArmed = true;
    const aP = request(MGR, { owner: OWNER, actor: "wcolla", lifecycleUid: uidA }, { opId: shared });
    // Keep A releasable on any failure path so a non-engaging run cannot hang the suite.
    let engaged = true;
    try {
      await Promise.race([enteredP, wait(6000).then(() => { throw new Error("A's barrier never parked in the evictor within 6s — the in-flight overlap this regression requires was not achieved"); })]);
    } catch (e) {
      engaged = false;
      // Liveness: if A never parked, DISARM so a late enter cannot park with no waiter, and release any
      // parked A — otherwise the evictor's `await` could hang the whole suite (never a clean fail).
      gateArmed = false;
      gateRelease?.();
      check("the coordinate-bind regression achieved its required in-flight overlap (A parked in barrier)", false, (e as Error).message);
    }
    if (engaged) {
      // A is parked in its barrier RIGHT NOW. B: same opId, DIFFERENT lifecycle — must be refused as a
      // full no-op, never inherit A's in-flight success. Assert directly, BEFORE releasing A.
      const rB = await request(MGR, { owner: OWNER, actor: "wcollb", lifecycleUid: uidB }, { opId: shared });
      const bSuccess = rB !== "no-reply" && rB.ok === true && ((rB.data as { retired?: boolean })?.retired === true || (rB.data as { alreadyRetired?: boolean })?.alreadyRetired === true);
      check("B (same opId, different lifecycle) is REFUSED while A is in flight (full no-op, names A's lifecycle)",
        rB !== "no-reply" && rB.ok === false && /different lifecycle/i.test(rB.error ?? "") && /FULL no-op/i.test(rB.error ?? ""), rB);
      check("B never inherits A's in-flight success (no retired:true / alreadyRetired for B)", !bSuccess, rB);
      check("B's lifecycle is provably STILL ACTIVE while A is in flight (no cross-lifecycle join freed B's alias)",
        (await readLifecycleHeadForOperation(wreg, OWNER, "wcollb"))?.mapping.state === "active");
    }
    // Release A; it completes its OWN legitimate retirement.
    gateRelease?.();
    const rA = await aP;
    check("the in-flight lifecycle A completes its OWN retirement end-to-end (retired:true, head retired)",
      rA !== "no-reply" && rA.ok === true && (rA.data as { retired?: boolean })?.retired === true
      && (await readLifecycleHeadForOperation(wreg, OWNER, "wcolla"))?.mapping.state === "retired", rA);
  }

  console.log(`\nAUTH-ADMIN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await wide?.close().catch(() => {});
  srv.kill("SIGTERM"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(process.exitCode ?? 0);
