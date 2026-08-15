/**
 * Cotal #391 — GUARDED GATE RECONCILIATION live smoke.
 *
 * Proves the keyed exit from an issuance gate left FROZEN by a crashed re-registration whose
 * freeze-holder is dead, and — the part that actually matters for a recovery path — proves it
 * REFUSES every state whose repair would be unsafe, naming WHICH condition refused.
 *
 * THE RESIDUE IS BUILT FOR REAL, NOT ASSEMBLED. State written from scratch cannot exercise a defect
 * that only exists in state written earlier, so each cell provisions a real gate, stages a real
 * `epcred` family row through the shipped gate adapter, and then drives the SHIPPED
 * `endpointRegistrationBarrier.freeze()` and ABANDONS the op — the crashed-restart residue written
 * by the same writer a real crash uses. No hand-written frozen row appears anywhere in this file.
 *
 * THE LIVENESS VERDICTS ARE REAL TOO. The probe under test is core's `observePrincipalLiveness`
 * over a REAL `$SYS` CONNZ observer against a REAL broker:
 *   - LIVE   = a real static-minted connection, open, attributed by its `principal:` tag;
 *   - GONE   = that same connection closed, proven absent by a complete single-server sweep;
 *   - UNKNOWN = a REAL under-report — a blind observer with no CONNZ grant, so the scan request is
 *     broker-denied and zero replies come back (the technique `evict-live-auth.smoke.ts` pins).
 * Only the daemon-unreachable cell is injected, because "the rail is down" is not something a
 * healthy broker can be asked to produce.
 *
 * WHAT IS UNDER TEST:
 *   implementations/manager/src/reconcile-gate.ts   — the guard, its order, and the named refusals
 *   implementations/manager/src/holder-liveness.ts  — the reply → verdict mapping (echo-bound)
 *   packages/core/src/evict.ts                      — observePrincipalLiveness + the shared sweep
 *
 * MUTATION TARGET (`pnpm mutation-proof`): turning verify-dead into assume-dead-on-timeout — e.g.
 * making `observePrincipalLiveness` return "gone" where it returns "unknown", or making the
 * reconciler proceed on a non-`gone` verdict — MUST redden the named cell
 * "REFUSAL 2 (unknown holder)". The dead-holder cell is its inverse control: it must stay green,
 * so a mutation that simply breaks everything is not mistaken for a killed mutation.
 *
 * COTAL_HOME-free; kills only the nats-server it starts, by exact PID (never pkill).
 * Run: npx tsx implementations/manager/smoke/gate-reconcile-auth.smoke.ts   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  mintMembershipObserverCreds, mintConnectionEvictorCreds,
  principalKey, standaloneConnectOpts, epAuthBucket, DEV_OWNER,
  provisionEndpointGateOpen, serveIssuanceGateKv, endpointRegistrationBarrier,
  epgateKey, parseEndpointGate, evictDeniedPrincipal, observePrincipalLiveness, mintLifecycleUid,
  MEMBERSHIP_INBOX_PREFIX,
} from "@cotal-ai/core";
import { holderLivenessFromReply } from "../src/holder-liveness.js";
import { GateReconcileRefused, reconcileEndpointGate, type GateReconcileCondition, type HolderLiveness } from "../src/reconcile-gate.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import {
  assertEphemeralBroker, assertNoLiveBrokerInEnv, scrubAmbientBrokerEnv,
} from "../../../packages/core/smoke/_ephemeral-only.js";

// ---------------------------------------------------------------------------
// FIRST ACTION, BEFORE ANY WORK: this smoke provisions credentials, revokes rows, and KICKs live
// connections. It must never be able to do that to the real mesh, so the live host is refused here
// — at the top, unconditionally — rather than trusted to be absent from the environment.
// ---------------------------------------------------------------------------
// SCRUB, THEN ASSERT — and the order is the point. This block used to REFUSE outright on an
// inherited `COTAL_SERVERS`, which meant this smoke could not run in the environment every
// mesh-connected agent on this box actually has: the connector exports the live coordinates, so the
// gate stopped here on every operator machine and ran only where someone had unset them by hand.
// A guard that fires in the normal environment does not protect the live broker — it protects
// nothing, because a gate nobody can complete is a gate nobody runs. Scrubbing removes the
// inherited coordinates from this process AND every child it spawns; the assert then still bites if
// anything re-introduces a live target afterwards, which is the case that would actually reach
// production. Refusing on ambient env catches the environment; asserting after scrubbing catches
// the code.
scrubAmbientBrokerEnv();
assertNoLiveBrokerInEnv();
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
assertEphemeralBroker(SERVERS);

const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SWEEP = { maxWaitMs: 1500, settleMs: 200, maxVerifyRounds: 3 } as const;
const ENDPOINT = "manager";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** Run the reconciler and report WHICH guard refused (or that it succeeded) — every cell asserts on
 *  this, so "it refused" can never be mistaken for "it refused for the right reason". */
const attempt = async (
  args: Parameters<typeof reconcileEndpointGate>[0],
): Promise<{ ok: true; report: Awaited<ReturnType<typeof reconcileEndpointGate>> } | { ok: false; condition: GateReconcileCondition | "threw"; message: string }> => {
  try {
    return { ok: true, report: await reconcileEndpointGate(args) };
  } catch (e) {
    if (e instanceof GateReconcileRefused) return { ok: false, condition: e.condition, message: e.message };
    return { ok: false, condition: "threw", message: (e as Error).message };
  }
};

// ---------- a real auth broker from a scratch dir ----------
const space = `gate391-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
// The two SYSTEM-account creds must be minted NOW: the in-memory $SYS signing seed is the only
// window in which they can be. The observer is what makes the liveness verdicts real.
const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());

const dir = mkdtempSync(join(tmpdir(), "cotal-gate391-"));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

let observerNc: NatsConnection | undefined, evictorNc: NatsConnection | undefined;
const holderConns: NatsConnection[] = [];
const execConns: NatsConnection[] = [];

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`the ephemeral broker did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // The `endpoint-serve-executor` cred is KEY-PINNED to one (endpoint, instanceId) — its KV write
  // grants name that instance's gate key and credential-family prefix and nothing else. So each
  // coordinate gets its own executor connection, exactly as the CLI command mints one for the
  // single instance the operator names. (Using one wide connection here would have tested a
  // credential the product never issues.)
  const execFor = async (instanceId: string): Promise<KV> => {
    const creds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint: ENDPOINT, instanceId },
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    execConns.push(nc);
    return await new Kvm(nc).open(epAuthBucket(space));
  };

  observerNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(enc(observerCreds)),
    inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0,
  });
  evictorNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(evictorCreds)), maxReconnectAttempts: 0 });

  // ---------- the REAL probe under test, wired exactly as the command wires it ----------
  // core's observePrincipalLiveness → the shipped reply→verdict mapping. A mutation to either is a
  // mutation to what these cells assert.
  const realProbe = (observer: NatsConnection) => async (principal: string): Promise<HolderLiveness> =>
    holderLivenessFromReply(await observePrincipalLiveness(observer, auth.account.pub, principal, SWEEP), principal);
  const realEvict = async (principal: string): Promise<boolean> =>
    (await evictDeniedPrincipal(observerNc!, evictorNc!, auth.account.pub, principal, SWEEP)).verifiedGone;

  /**
   * Build the crashed-restart residue FOR REAL at a fresh coordinate, and (optionally) leave a live
   * connection holding the freeze-holder principal.
   *
   * Order matters and mirrors the real crash: provision the gate open → stage a real family row
   * through the shipped gate adapter → the SHIPPED barrier freezes it → the op is ABANDONED. What
   * remains is `frozen` under a `registration` op, written by the barrier's own freeze CAS.
   */
  const buildResidue = async (opts: { holderLive: boolean }): Promise<{ instanceId: string; principal: string; kv: KV; conn?: NatsConnection }> => {
    const instanceId = mintLifecycleUid();
    const actor = `h${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const principal = principalKey(DEV_OWNER, actor).key;
    const kv = await execFor(instanceId);

    await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId, principal });
    // A real family row, staged through the shipped adapter (which round-trips it through the
    // consuming parser), so enumerate/revoke below act on a genuine `epcred` row.
    const gate = serveIssuanceGateKv(kv, space, { endpoint: ENDPOINT, instanceId });
    await gate.stage({
      credentialId: mintLifecycleUid(),
      credentialKey: "", holderPrincipal: principal, endpoint: ENDPOINT, lifecycleUid: instanceId,
      sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 3600,
      generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
    });

    // A live connection ATTRIBUTED to the freeze-holder principal: a static mint stamps the
    // `principal:` tag, so CONNZ attributes it exactly as it attributes a real serving connection.
    let conn: NatsConnection | undefined;
    if (opts.holderLive) {
      const hid = newIdentity();
      const hcreds = await mintCreds(auth, hid, "agent", { principal: { owner: DEV_OWNER, actor }, lifecycleUid: mintLifecycleUid() });
      conn = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: hcreds, tls: false }), maxReconnectAttempts: 0 });
      holderConns.push(conn);
    }

    // THE CRASH: the shipped barrier freezes, and the op never completes.
    const observed = await gate.observe();
    if (observed === null) throw new Error("the gate vanished right after provisioning");
    const frozen = await endpointRegistrationBarrier(kv, space, {
      endpoint: ENDPOINT, instanceId, opId: mintLifecycleUid(),
    }).freeze(observed.revision);
    if (frozen === null) throw new Error("the shipped barrier did not freeze the gate — residue not built");
    return { instanceId, principal, kv, ...(conn ? { conn } : {}) };
  };

  // Prove the construction produced the defect's state, not something that merely resembles it.
  {
    const { instanceId, kv } = await buildResidue({ holderLive: false });
    const entry = await kv.get(epgateKey(ENDPOINT, instanceId));
    const row = parseEndpointGate(entry!.value, epgateKey(ENDPOINT, instanceId));
    check(
      "RESIDUE: the SHIPPED barrier's own freeze left the gate frozen under a registration op (the crashed-restart state, not a hand-written row)",
      row.state === "frozen" && row.op?.kind === "registration" && typeof row.op?.opId === "string" && row.op.opId.length > 0,
      row,
    );
  }

  // ---------- INVERSE CONTROL: the dead-holder case SUCCEEDS ----------
  // Without this, a mutation that breaks the probe entirely would redden the refusal cells and read
  // as "the guard works". This is the cell that must stay GREEN.
  {
    const { instanceId, principal, kv, conn } = await buildResidue({ holderLive: true });
    await conn!.close(); // the holder DIES — the crashed incarnation is gone
    await wait(300);
    const before = parseEndpointGate((await kv.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    const r = await attempt({
      kv, space, endpoint: ENDPOINT, instanceId,
      probeHolder: realProbe(observerNc), evict: realEvict, log: () => {},
    });
    check("INVERSE CONTROL (dead holder): the reconciliation SUCCEEDS", r.ok === true, r.ok ? undefined : r);
    if (r.ok) {
      check("INVERSE CONTROL: the verdict was an AFFIRMATIVE `gone`, not an inference", r.report.liveness.state === "gone", r.report.liveness);
      check("INVERSE CONTROL: the family row was revoked and the holder verify-evicted",
        r.report.revoked.length === 1 && r.report.evicted.includes(principal), { revoked: r.report.revoked, evicted: r.report.evicted });
    }
    const after = parseEndpointGate((await kv.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    check(
      "INVERSE CONTROL: the gate is OPEN at generation+1 with the coordinate otherwise UNCHANGED (the dead op wrote nothing forward)",
      after.state === "open" && after.op === undefined && after.generation === before.generation + 1 &&
      after.processEpoch === before.processEpoch && after.registrationRevision === before.registrationRevision &&
      after.nameAuthorityRevision === before.nameAuthorityRevision,
      { before, after },
    );
  }

  // ---------- REFUSAL 1 (live holder) ----------
  {
    const { instanceId, principal, kv } = await buildResidue({ holderLive: true }); // connection stays OPEN
    const r = await attempt({
      kv, space, endpoint: ENDPOINT, instanceId,
      probeHolder: realProbe(observerNc), evict: realEvict, log: () => {},
    });
    check("REFUSAL 1 (live holder): refuses with condition `holder-alive`", r.ok === false && r.condition === "holder-alive", r);
    check("REFUSAL 1: the refusal NAMES liveness and the live principal",
      r.ok === false && /ALIVE/.test(r.message) && r.message.includes(principal), r.ok ? undefined : r.message);
    const still = parseEndpointGate((await kv.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    check("REFUSAL 1: the gate is UNTOUCHED — still frozen (a live manager was not evicted)", still.state === "frozen", still);
    const rows = await endpointRegistrationBarrier(kv, space, { endpoint: ENDPOINT, instanceId, opId: mintLifecycleUid() }).enumerate();
    check("REFUSAL 1: the credential family is UNTOUCHED — the row is still active (refuse happened BEFORE any mutation)",
      rows.length === 1 && rows[0]?.state === "active", rows);
  }

  // ---------- REFUSAL 2 (unknown holder) — THE NAMED MUTATION CELL ----------
  // A REAL under-report: the blind connection holds no CONNZ grant, so the sweep gets zero replies.
  // The holder here is genuinely DEAD (its connection was closed) — so the ONLY thing standing
  // between this cell and a "success" is the refusal to treat an unprovable sweep as death. That is
  // exactly the assume-dead-on-timeout mutation, and it is why this cell is the named target.
  {
    const { instanceId, kv, conn } = await buildResidue({ holderLive: true });
    await conn!.close();
    await wait(300);
    const r = await attempt({
      kv, space, endpoint: ENDPOINT, instanceId,
      probeHolder: realProbe(evictorNc!), // blind: kick-only cred, no CONNZ read grant
      evict: realEvict, log: () => {},
    });
    check("REFUSAL 2 (unknown holder): refuses with condition `holder-unknown`", r.ok === false && r.condition === "holder-unknown", r);
    check("REFUSAL 2: the refusal NAMES unknowability, not death",
      r.ok === false && /UNKNOWN/.test(r.message) && /absence of evidence is not evidence of absence/i.test(r.message),
      r.ok ? undefined : r.message);
    const still = parseEndpointGate((await kv.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    check("REFUSAL 2: the gate stays frozen — an unprovable sweep never authorizes the repair", still.state === "frozen", still);
    // The under-report is REAL, pinned at the primitive: sweepComplete:false, verdict unknown.
    const raw = await observePrincipalLiveness(evictorNc!, auth.account.pub, principalKey(DEV_OWNER, "ghost").key, SWEEP);
    check("REFUSAL 2: the underlying sweep genuinely under-reported (sweepComplete:false ⇒ unknown, never a silent absence)",
      raw.state === "unknown" && raw.sweepComplete === false, raw);
  }

  // ---------- REFUSAL 3 (liveness unestablishable) ----------
  // The rail being down is not something a healthy broker can be asked to produce, so this verdict
  // is injected — but the MAPPING that produces it is the shipped one, exercised below.
  {
    const { instanceId, kv } = await buildResidue({ holderLive: false });
    const r = await attempt({
      kv, space, endpoint: ENDPOINT, instanceId,
      probeHolder: async () => ({ state: "unestablishable", detail: "the delivery daemon is not reachable on the ctl.delivery-admin rail (connect ECONNREFUSED)" }),
      evict: realEvict, log: () => {},
    });
    check("REFUSAL 3 (no oracle): refuses with condition `liveness-unestablishable`", r.ok === false && r.condition === "liveness-unestablishable", r);
    check("REFUSAL 3: the refusal names the missing oracle and disclaims inference from silence",
      r.ok === false && /CANNOT BE ESTABLISHED/.test(r.message) && /will not infer death from silence/i.test(r.message),
      r.ok ? undefined : r.message);
  }

  // ---------- The reply → verdict mapping: every non-verdict is a refusal ----------
  {
    const p = principalKey(DEV_OWNER, "mapcheck").key;
    const other = principalKey(DEV_OWNER, "someoneelse").key;
    check("MAPPING: a reply describing a DIFFERENT principal is unestablishable (echo-bound, never authorizes)",
      holderLivenessFromReply({ principal: other, state: "gone", sweepComplete: true }, p).state === "unestablishable");
    check("MAPPING: a garbled reply is unestablishable",
      holderLivenessFromReply({ nonsense: true }, p).state === "unestablishable");
    check("MAPPING: an absent reply is unestablishable",
      holderLivenessFromReply(undefined, p).state === "unestablishable");
    check("MAPPING: `gone` under an INCOMPLETE sweep is contradictory ⇒ unestablishable, never gone",
      holderLivenessFromReply({ principal: p, state: "gone", sweepComplete: false }, p).state === "unestablishable");
    check("MAPPING: a well-formed, echoing, complete `gone` is the ONLY shape that yields gone",
      holderLivenessFromReply({ principal: p, state: "gone", sweepComplete: true }, p).state === "gone");
    check("MAPPING: `live` passes through as live", holderLivenessFromReply({ principal: p, state: "live", sweepComplete: true }, p).state === "live");
  }

  // ---------- THE LOST-PAGE UNDER-REPORT (adversary seat, Finding 1) ----------
  // A sweep that PAGINATES can lose a later page: page 0 comes back full with `total` promising
  // more, and the next round is silent. The bug this pins is that the loop used to read that
  // silence as the END of the data — `sweepComplete:true` — so a principal living on the page that
  // was never delivered read as absent, and absent-under-a-complete-sweep is exactly what
  // authorizes `gone`. That is "a dropped reply on the gone side": the one thing this command must
  // never do. Scripted, because a healthy broker will not drop a page on demand.
  {
    const VICTIM = principalKey(DEV_OWNER, "pagevictim").key;
    const pageOpts = { settleMs: 50, maxWaitMs: 300, pageLimit: 1 } as const;
    const rounds = (pages: unknown[][]): NatsConnection => {
      let round = 0;
      let cb: ((e: unknown, m: { json: () => unknown }) => void) | undefined;
      return {
        subscribe: (_s: string, o: { callback: (e: unknown, m: { json: () => unknown }) => void }) => { cb = o.callback; return { unsubscribe: () => {} }; },
        publish: () => { const rs = pages[round++] ?? []; setTimeout(() => { for (const r of rs) cb?.(null, { json: () => r }); }, 0); },
      } as unknown as NatsConnection;
    };
    const row = (p: string) => ({ cid: 1000 + Math.floor(Math.random() * 1000), tags: [`principal:${p}`] });
    const pg = (conns: unknown[], total: number) => ({ server: { id: "SERVER_A" }, data: { server_id: "SERVER_A", total, connections: conns } });
    const pgAt = (conns: unknown[], total: number, offset: number) => ({ server: { id: "SERVER_A" }, data: { server_id: "SERVER_A", total, offset, connections: conns } });

    const lost = await observePrincipalLiveness(rounds([[pg([row(principalKey(DEV_OWNER, "filler").key)], 2)], []]), "ACC", VICTIM, pageOpts);
    check("LOST PAGE: page0 full + page1 SILENT is an UNDER-REPORT, not an ending — unknown, sweepComplete:false (never a false `gone`)",
      lost.state === "unknown" && lost.sweepComplete === false, lost);
    const verdict = holderLivenessFromReply(lost, VICTIM);
    check("LOST PAGE: the reconciler's mapping refuses it (a lost page can never authorize the repair)",
      verdict.state !== "gone", verdict);

    // Inverse control: every page delivered, victim on the LAST one — it must read live, so the fix
    // is "notice the loss", not "refuse whenever there is more than one page".
    const seen = await observePrincipalLiveness(rounds([[pg([row(principalKey(DEV_OWNER, "filler").key)], 2)], [pg([row(VICTIM)], 2)]]), "ACC", VICTIM, pageOpts);
    check("LOST PAGE inverse control: with every page delivered, a victim on the LAST page reads LIVE",
      seen.state === "live" && seen.sweepComplete === true, seen);
    // And a genuinely finished multi-page sweep still yields `gone` — the fix must not wedge it.
    const done = await observePrincipalLiveness(rounds([[pg([row(principalKey(DEV_OWNER, "filler").key)], 2)], [pg([row(principalKey(DEV_OWNER, "filler2").key)], 2)]]), "ACC", VICTIM, pageOpts);
    check("LOST PAGE inverse control: a COMPLETE multi-page sweep with the victim nowhere still reads GONE (no permanent wedge)",
      done.state === "gone" && done.sweepComplete === true, done);

    // ANSWERING IS NOT DELIVERING. A narrower sibling of the lost page, found on re-review of the
    // first fix: a server that owes the rest of its data can reply with a WELL-FORMED EMPTY page
    // while its own `total` still says there is more. That is not an ending, but it cleared the
    // debt exactly as silence used to — so the sweep called itself complete on page 0's rows alone.
    // An owed server now discharges its debt only by handing data over, or by showing there is
    // none left (`offset >= total`).
    const emptyMid = await observePrincipalLiveness(rounds([[pgAt([row(principalKey(DEV_OWNER, "filler").key)], 3, 0)], [pgAt([], 3, 1)]]), "ACC", VICTIM, pageOpts);
    check("EMPTY MID-PAGE: an owed server answering with an empty page while offset < total is an UNDER-REPORT (answering is not delivering)",
      emptyMid.state === "unknown" && emptyMid.sweepComplete === false, emptyMid);
    // The inverse control has to reach the `offset >= total` branch as an OWED server, or it is
    // green for the wrong reason. A first draft used total:1, which made page 0 not-full — the loop
    // never paginated, nothing was ever owed, and the cell passed on "single page, complete" while
    // appearing to test the discharge rule. So page 0 is FULL and owing, and page 1 comes back
    // empty with a SHRUNK total (connections closed mid-sweep — real churn): offset has now reached
    // that total, there is genuinely nothing left to hand over, and the debt is discharged.
    const legitEnd = await observePrincipalLiveness(rounds([[pgAt([row(principalKey(DEV_OWNER, "filler").key)], 5, 0)], [pgAt([], 1, 1)]]), "ACC", VICTIM, pageOpts);
    check("EMPTY MID-PAGE inverse control: an OWED server whose offset has reached its (shrunk) total is a legitimate END — still GONE (the rule demands progress, not data that no longer exists)",
      legitEnd.state === "gone" && legitEnd.sweepComplete === true, legitEnd);

    // THE SECOND GUARD SHARED THE SAME HOLE. The design says the probe is a precondition ON TOP OF
    // the barrier's verified eviction — but belt-and-braces is worthless if both are the same belt.
    // `evictDeniedPrincipal` paginates through the same shape, so a lost page made `verifiedGone`
    // lie in exactly the way it made the probe lie. Pinned here so the two guards stay independent.
    const evicted = await evictDeniedPrincipal(
      rounds([[pg([row(principalKey(DEV_OWNER, "filler").key)], 2)], []]),
      evictorNc!, "ACC", VICTIM, { ...pageOpts, maxVerifyRounds: 1 },
    );
    check("LOST PAGE (eviction path): a lost page is scanComplete:false / verifiedGone:false — the barrier's own guard does not inherit the probe's blind spot",
      evicted.verifiedGone === false && evicted.scanComplete === false, evicted);
  }

  // ---------- REFUSAL 4/5: states this repair does not own ----------
  {
    // not-frozen: a freshly provisioned, still-OPEN gate.
    const openInstance = mintLifecycleUid();
    const openKv = await execFor(openInstance);
    await provisionEndpointGateOpen(openKv, { endpoint: ENDPOINT, instanceId: openInstance, principal: principalKey(DEV_OWNER, "opengate").key });
    const r1 = await attempt({
      kv: openKv, space, endpoint: ENDPOINT, instanceId: openInstance,
      probeHolder: async () => { throw new Error("the probe must not run on a gate that is not frozen"); },
      evict: realEvict, log: () => {},
    });
    check("REFUSAL 4 (not frozen): refuses with condition `not-frozen`, BEFORE probing", r1.ok === false && r1.condition === "not-frozen", r1);

    // no-gate: a coordinate that was never provisioned.
    const missing = mintLifecycleUid();
    const r2 = await attempt({
      kv: await execFor(missing), space, endpoint: ENDPOINT, instanceId: missing,
      probeHolder: async () => { throw new Error("the probe must not run when there is no gate"); },
      evict: realEvict, log: () => {},
    });
    check("REFUSAL 5 (no gate): refuses with condition `no-gate`", r2.ok === false && r2.condition === "no-gate", r2);
  }

  // ---------- REFUSAL 6 (eviction unverified): the barrier's own fail-closed step still governs ----------
  // The probe passes (the holder really is dead) but the evictor cannot VERIFY. Both guards must
  // pass, so the gate stays frozen — this is the cell that proves the probe did not REPLACE the
  // barrier's eviction.
  {
    const { instanceId, kv, conn } = await buildResidue({ holderLive: true });
    await conn!.close();
    await wait(300);
    const r = await attempt({
      kv, space, endpoint: ENDPOINT, instanceId,
      probeHolder: realProbe(observerNc), evict: async () => false, log: () => {},
    });
    check("REFUSAL 6 (eviction unverified): refuses with condition `eviction-unverified` even though the probe said gone",
      r.ok === false && r.condition === "eviction-unverified", r);
    const still = parseEndpointGate((await kv.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    check("REFUSAL 6: the gate stays frozen (the probe is a precondition ON TOP OF the barrier, not a replacement)", still.state === "frozen", still);
  }

  // ---------- The probe is READ-ONLY: observing a live holder never disturbs it ----------
  {
    const { principal, conn } = await buildResidue({ holderLive: true });
    const v = await realProbe(observerNc)(principal);
    await wait(300);
    check("READ-ONLY: probing a LIVE holder reports live and leaves the connection connected (no KICK on the read path)",
      v.state === "live" && !conn!.isClosed(), { verdict: v, closed: conn!.isClosed() });
    await conn!.close();
  }

  console.log(`\nGATE-RECONCILE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const nc of [...holderConns, ...execConns, observerNc, evictorNc]) { try { await nc?.close(); } catch { /* */ } }
  srv.kill("SIGKILL"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
