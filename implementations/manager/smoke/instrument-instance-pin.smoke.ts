/**
 * INSTRUMENT INSTANCE PIN (#397) — `--on <instanceId>` reaches the MINT, so the one-shot operator
 * instrument is issued the exact instance rails for the invocation it was minted for.
 *
 * The defect was a parameter stopping one layer short. The client always routed an
 * instance-addressed request onto the `ep.inst` rail; every serve credential always subscribed it;
 * and the mint site already documented this exact case — `operatorInstrumentCapabilities` says the
 * non-scatter reads stay `one`-only "or `inst` when a resolve pins `--on`". That `inst` case could
 * not happen: the emitter builds an instance row only for a capability carrying an `instanceId`,
 * and nothing upstream ever passed one. `resolveControlTarget` took a profile and no instance, and
 * neither did the mint beneath it. The absence produced no error — just an unminted row, a refused
 * publish, and a client that renders that refusal as a describe timeout. Nothing to notice.
 *
 * The fix threads the instance the resolve already chose down into the mint. It is EXACT-ARITY: the
 * credential gets `ep.inst.<endpoint>.<thatInstance>.<command>` and no wildcard instance is minted
 * anywhere. That is what keeps `inst-route-grant`'s denied arm intact, and CELL 1 below asserts it
 * rather than assuming it — a wildcard row would satisfy every live check in this file while
 * quietly destroying the boundary, so the boundary is checked directly.
 *
 * COVERAGE BOUNDARY, stated so this is not over-read. Cells 1-4 build their own inputs: they call
 * `instancePinnedInstrumentCapabilities` and mint directly. So they prove the GRANT SHAPING and the
 * live rails end to end — a pinned instrument reaches the instance it names, an unpinned one still
 * cannot, and no ordinary credential gains a route. They do NOT prove the CLI threads `--on` down
 * to the mint: `agents.ts`/`spawn.ts` -> `resolveControlTarget` -> `connectOrExit` type-checks with
 * the argument dropped anywhere along it. That gap is no longer merely named; it is covered by
 * `cli-on-instance-live.smoke.ts`, which drives the real binary; and it was a real shipped defect,
 * not a hypothetical. Keep the two suites distinct: "the pin works" and "the flag reaches the pin"
 * are different claims, evidenced in different files.
 *
 * Cells 5 and 6 grade the describe's permission watch and the split-retry guard, and both reach
 * into internals on purpose (the transport's status-listener registry; `Endpoint`'s resolved-service
 * cache). Neither has a public accessor, and both guard regressions that every functional assertion
 * in this file would miss: a leaked listener per resolve, and a mutating command re-issued after a
 * responder already answered it (a second attempt that may duplicate its effect).
 *
 * Run: pnpm smoke:instrument-instance-pin
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER, EpEnvelopeError,
  resolveService, invokeCommand, permissionsFor,
  instancePinnedInstrumentCapabilities, respondedButUnbound, replyRefusedBeforeEffect, EP_UNBOUND_RESPONDER, CotalEndpoint,
  isRepeatSafeCommand, MANAGER_ADMIN_COMMANDS,
  type EpCaller,
  type ResolvedService,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`this probe only runs against an ephemeral loopback broker; got ${SERVERS}`);
console.log(`broker-url guard: ${SERVERS} is ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

/** A READ, RETRIED AT THE TEST LEVEL, and the reason is worth stating because it is a product
 *  characteristic rather than a fixture wrinkle. `invokeService` absorbs a class-queue split with
 *  exactly ONE re-resolve; in a two-manager space that re-resolve can split again, so an ordinary
 *  read surfaces roughly one time in four. That is pre-existing (the single retry long predates this
 *  change, and the second failure has always propagated) and is reported, not fixed here.
 *
 *  Any cell that calls `ps` ONCE inherits that 25% and reads as a flaky test rather than the product
 *  behaviour it is, which is exactly what happened: cell 7's warm-up was written as a bare single
 *  call and went red on an otherwise green sweep. Shared, so the next cell that needs a warm read
 *  cannot quietly reintroduce it. The tolerance is explicit and bounded; it is not a retry loop
 *  hiding a failure, because a genuine break exhausts all six attempts and still reports. */
/** PUB count on the endpoint's own connection: the direct witness for "nothing was re-issued".
 *  One invoke on a cached resolve is exactly ONE publish; the self-heal path re-resolves (a
 *  describe plus the contract-store reads behind it) and invokes again, so it is many. Read before
 *  and after a call, compare the delta. */
const pubs = (ep: CotalEndpoint): number =>
  (ep as unknown as { nc: { stats(): { outMsgs: number } } }).nc.stats().outMsgs;

/**
 * THE DISPOSITION AND THE EFFECT MUST AGREE — the deterministic form of "exactly once", and the
 * reason "exactly once" could not be asserted literally.
 *
 * A re-issue goes back through the SAME class queue, so in a two-manager space it can be refused a
 * second time. That is not a defect and it is not new (the single retry long predates this change);
 * it means a call may legitimately end having run ZERO times. `=== 1` would therefore be a flaky
 * assertion of a true property, which is the worst of both — it would go red on a correct run about
 * half the time, and the fix would be to weaken it until it stopped noticing anything.
 *
 * What IS deterministic is the biconditional: a reply carrying the bind refusal means the command
 * did not run, and any other reply means it ran exactly once. A duplicate breaks it (two runs on one
 * reply); a lost effect reported as success breaks it; a refusal after the handler ran breaks it.
 */
const dispositionAgrees = (
  reply: { ok?: boolean; error?: { code?: string; details?: { kind: string }[] } } | undefined,
  ranDelta: number,
): boolean => ranDelta === (replyRefusedBeforeEffect(reply?.error) ? 0 : 1);

const readTolerant = async (
  ep: CotalEndpoint, label: string, attempts = 6,
): Promise<{ ok: boolean; tries: number; last?: unknown }> => {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await ep.invokeService(MANAGER_ENDPOINT, "ps");
      if (r.reply.ok === true) return { ok: true, tries: i };
      last = r.reply.error;
    } catch (e) { last = e instanceof Error ? e.message.slice(0, 120) : e; }
  }
  console.log(`   ${label}: no success in ${attempts} attempts`);
  return { ok: false, tries: attempts, last };
};

const space = `pin-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-pin-"));
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

type MgrPriv = { managerInstanceId: string };
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;

// Built the same way inst-route-grant builds it, deliberately: `permissionsFor` is called directly
// rather than through `mintCreds`, so nothing assembles the principal for us — `instrumentEpRows`
// reads `pr.lifecycleUid` and fails loud without it, and the inbox guard needs a connId of at
// least 8 safe characters.
const pubRows = (profile: string, actor: string, opts: Record<string, unknown>): string[] => {
  const pr = {
    owner: DEV_OWNER, actor, connId: `conn${actor.replace(/[^A-Za-z0-9]/g, "")}0000`,
    ...(opts.lifecycleUid ? { lifecycleUid: opts.lifecycleUid as string } : {}),
  };
  const perms = permissionsFor(profile as never, space, pr as never, opts as never) as
    { pub?: { allow?: string[] } };
  return perms.pub?.allow ?? [];
};
const instRows = (rows: string[]): string[] => rows.filter((r) => r.includes(".ep.inst."));

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1"), root2 = mkRoot("ws2");
  for (const r of [root1, root2]) recordMesh({ space, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  m1 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  /**
   * THE EXECUTION COUNTER — the instrument this suite did not have, and the reason several of its
   * cells had to be re-cut rather than merely re-run.
   *
   * Every cell below that once asked "did the effect happen twice" asked it as "did more than one
   * message leave the caller". That proxy held while a split was detected AFTER the responder had
   * handled the request: a second publish then meant a second execution. Under the pre-effect fence
   * it is the opposite — the first attempt is refused before the handler, so the SECOND publish
   * carries the FIRST execution, and the proxy now reports a repaired call and a duplicated one
   * identically. Counting publishes cannot be made to work here; it has to be counted where the
   * effect is applied.
   *
   * So: wrap each served command's handler, per manager, and count entries. The fence sits ahead of
   * the handler, so an increment means the command RAN — not that a request arrived, not that a
   * reply came back. Installed before `start()` because the defs are built at serve time.
   */
  const ran: Record<string, number> = Object.create(null);
  const totalRuns = (command: string): number => ran[command] ?? 0;
  for (const m of [m1, m2]) {
    const priv = m as unknown as { managerServiceDefs: () => { command: string; handler: (ctx: unknown) => unknown }[] };
    const orig = priv.managerServiceDefs.bind(priv);
    priv.managerServiceDefs = () => orig().map((d) => ({
      ...d,
      handler: (ctx: unknown) => { ran[d.command] = (ran[d.command] ?? 0) + 1; return d.handler(ctx); },
    }));
  }
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers registered distinct instance ids", IID1 !== IID2, { IID1, IID2 });

  // ---- 1. THE BOUNDARY THIS FIX MUST NOT MOVE -------------------------------------------------
  // Mirrors inst-route-grant's denied arm. A wildcard fix would pass every LIVE check below while
  // destroying exactly this, so it is asserted here too rather than left to another suite.
  console.log("\n1. the denied arm is untouched — no ordinary credential gains an instance route");
  for (const [who, opts] of [
    ["agent/plainagent", { lifecycleUid: "cc11dd22ee33ff4455aa66bb77" }],
    ["agent/spawneragent", { lifecycleUid: "dd11ee22ff33aa4455bb66cc77", capabilities: ["spawn"] }],
  ] as const) {
    const rows = instRows(pubRows("agent", who.split("/")[1], opts as Record<string, unknown>));
    check(`${who} still holds NO instance route`, rows.length === 0, rows.slice(0, 3));
  }
  const unpinnedInstrument = instRows(pubRows("control-caller-privileged", "unpinnedinstr", { lifecycleUid: "aa11bb22cc33dd44ee55ff6677" }));
  check("an instrument minted WITHOUT a pin also holds none (the pin is opt-in, not implicit)",
    unpinnedInstrument.length === 0, unpinnedInstrument.slice(0, 3));

  // ---- 2. THE PIN IS EXACT, NEVER A WILDCARD ---------------------------------------------------
  console.log("\n2. a pinned mint yields EXACT-instance rows only");
  const pinnedRows = instRows(pubRows("control-caller-privileged", "pinnedinstr",
    { lifecycleUid: "bb11cc22dd33ee44ff5566aa77", endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", IID1) }));
  check("it gains instance rows", pinnedRows.length > 0, pinnedRows.length);
  check("EVERY one names the exact instance — no `.ep.inst.*.` wildcard anywhere",
    pinnedRows.every((r) => r.includes(`.ep.inst.manager.${IID1}.`)), pinnedRows.filter((r) => !r.includes(IID1)).slice(0, 3));
  check("it includes the pinned DESCRIBE (without it the resolve that must precede an invoke is refused)",
    pinnedRows.some((r) => r.includes(`.ep.inst.manager.${IID1}.describe.`)), pinnedRows.slice(0, 4));
  check("the pin does NOT reach the other live instance", pinnedRows.every((r) => !r.includes(IID2)), IID2);
  let malformed = "accepted";
  try { instancePinnedInstrumentCapabilities("privileged", "not a valid token!"); } catch { malformed = "refused"; }
  check("a malformed instance id is refused AT MINT, never widened into a subject", malformed === "refused", malformed);

  // ---- 3. LIVE: the pinned instrument works; the unpinned one is the before-state ---------------
  const liveResolve = async (label: string, pin: boolean, iid: string): Promise<{ ok: boolean; why?: string; detail?: string; answered?: string }> => {
    const id = newIdentity(); const uid = mintLifecycleUid();
    const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
    const creds = await mintCreds(auth, id, "control-caller-privileged", {
      lifecycleUid: uid,
      ...(pin ? { endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", iid) } : {}),
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    try {
      const svc = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000, instanceId: iid });
      const reply = await invokeCommand(nc, space, svc, "status", undefined, { deadlineMs: 8_000 });
      return { ok: true, answered: reply.responder.instanceId };
    } catch (e) {
      return {
        ok: false,
        why: e instanceof EpEnvelopeError ? `${e.code}` : (e as Error).message.slice(0, 60),
        detail: (e as Error).message,
      };
    } finally { await nc.drain().catch(() => nc.close()); }
  };

  console.log("\n3. live: pinned describe + pinned invoke, on a real two-manager mesh");
  const withPin = await liveResolve("pinned", true, IID1);
  console.log(`   pinned instrument   -> ${withPin.ok ? `OK, answered by ${withPin.answered === IID1 ? "the instance it named" : withPin.answered}` : withPin.why}`);
  check("a PINNED instrument resolves and invokes on the instance rail", withPin.ok, withPin.why);
  check("...and the answer comes from the instance it named, not the class queue",
    withPin.answered === IID1, { want: IID1, got: withPin.answered });
  const pinB = await liveResolve("pinnedB", true, IID2);
  check("the same holds for the OTHER instance (not an artefact of which manager started first)",
    pinB.ok && pinB.answered === IID2, pinB.ok ? pinB.answered : pinB.why);

  // The negative control: the exact state this change fixes. Same code path, same profile, same
  // instance — only the pin removed. It must still fail, or phase 3 proves nothing about the pin.
  const noPin = await liveResolve("unpinned", false, IID1);
  console.log(`   unpinned instrument -> ${noPin.ok ? "OK (UNEXPECTED)" : noPin.why}`);
  check("an UNPINNED instrument still cannot address an instance — the fix is the pin, not the plumbing",
    !noPin.ok, noPin.answered);

  // ---- 4. THE REFUSAL SAYS IT IS A REFUSAL -----------------------------------------------------
  // The cell above only asks that the unpinned call FAILS. HOW it fails is the load-bearing part,
  // and for a long time it failed as a bare `deadline-exceeded`: the broker refuses the publish on
  // the connection, asynchronously, so the caller observed nothing but silence and read it as "that
  // instance is not there". A missing GRANT and a missing RESPONDER need opposite responses, and
  // this is the only place the two are distinguishable, so assert the distinction rather than
  // trusting the message. Without this, the reworded refusal could stop firing and nothing notices.
  console.log("\n4. the denied publish is LOUD: a missing grant never reads as an absent responder");
  check("it is reported as permission-denied, NOT a describe deadline",
    noPin.why === "permission-denied", { got: noPin.why, detail: noPin.detail?.slice(0, 200) });
  check("...and it names the subject the credential lacked, so the remedy is readable off the error",
    (noPin.detail ?? "").includes(`.ep.inst.manager.${IID1}.describe.`), noPin.detail?.slice(0, 260));
  check("...and says the responder may be healthy (the wrong conclusion is the expensive one)",
    /REFUSED BY THE BROKER/.test(noPin.detail ?? "") && /grant is what is missing/.test(noPin.detail ?? ""),
    noPin.detail?.slice(0, 260));

  // ---- 5. THE WATCH RELEASES ITSELF ------------------------------------------------------------
  // The permission watch in cell 4 subscribes the connection's status stream. That stream is
  // connection-lived, so a describe that does not RELEASE its listener leaks one per resolve, an
  // unbounded growth on exactly the long-lived connections the mesh runs on, and invisible to every
  // functional assertion above, which is how the first cut of this shipped. `return()` is not
  // enough: the transport's generator parks on an internal signal await, so a queued return does
  // not run until the next status event, which on a healthy connection may never arrive.
  //
  // This reaches into `protocol.listeners` deliberately. The registration is internal and there is
  // no public accessor, so the choice is to assert on the internal or not to assert at all, and
  // "cleanup happens" was claimed once already without evidence. If a transport upgrade moves this,
  // the cell fails loud and gets rewritten, which is the correct outcome for a probe of internals.
  console.log("\n5. the describe's permission watch does not leak a status listener per resolve");
  {
    const id = newIdentity(); const uid = mintLifecycleUid();
    const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
    const creds = await mintCreds(auth, id, "control-caller-privileged", {
      lifecycleUid: uid, endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", IID1),
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    const listeners = (): number =>
      ((nc as unknown as { protocol?: { listeners?: unknown[] } }).protocol?.listeners ?? []).length;
    try {
      const before = listeners();
      check("the internal listener registry is reachable (else this cell proves nothing)",
        Array.isArray((nc as unknown as { protocol?: { listeners?: unknown[] } }).protocol?.listeners), before);
      const ROUNDS = 12;
      for (let i = 0; i < ROUNDS; i++)
        await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000, instanceId: IID1 });
      const after = listeners();
      console.log(`   listeners before=${before} after ${ROUNDS} pinned resolves=${after}`);
      check(`${ROUNDS} resolves leave the listener count where they found it`, after === before, { before, after });
    } finally { await nc.drain().catch(() => nc.close()); }
  }

  // ---- 6. A SPLIT IS NEVER AUTO-RETRIED --------------------------------------------------------
  // `Endpoint.invokeService` recovers from `failed-precondition` by dropping the cached resolve and
  // invoking AGAIN. That was written for one reading of the code, "the describe-bound incarnation
  // is gone, so the first invoke never ran, and a second is a repair". The describe-bound currency
  // check also raises it in a case where that premise is FALSE: a different live instance wins the
  // class queue and REPLIES, so the request was received and answered (executed or refused; the
  // reply does not say which), and the error is raised afterwards. Re-invoking there is a second
  // attempt at a mutating command that may already have taken effect (the "one spawn, several
  // seats" shape) while the error text tells the operator not to retry.
  //
  // Made deterministic rather than raced: resolve for real, then doctor the CACHED responder id to
  // an instance that does not exist. Every subsequent class-queue answer is then "not the bound
  // incarnation" on every run, whichever manager wins. Reaching into `resolvedServices` is the
  // point; that cache is what the retry drops, and there is no public way to age it.
  console.log("\n6. a responder that ANSWERED is never silently re-invoked");
  {
    const id = newIdentity(); const uid = mintLifecycleUid();
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds: await mintCreds(auth, id, "control-caller-privileged", { lifecycleUid: uid }),
      card: { id: id.id, name: "pin-split-probe", role: "operator", kind: "endpoint" },
      channels: [], consume: false, registerPresence: false, watchPresence: false, lifecycleUid: uid,
    });
    ep.on("error", () => {});
    await ep.start();
    try {
      const warm = await readTolerant(ep, "warm-up");
      check("the probe can invoke ps before the split is forced", warm.ok, warm.last);
      const cache = (ep as unknown as { resolvedServices: Map<string, { responder: { instanceId: string } }> }).resolvedServices;
      const cached = cache.get(MANAGER_ENDPOINT);
      const ghost = `${"q".repeat(4)}${IID1.slice(4)}`;
      check("the cached resolve is reachable and the forced id is neither live instance",
        cached !== undefined && ghost !== IID1 && ghost !== IID2 && /^[a-z0-9]{26,32}$/.test(ghost), ghost);
      if (cached) cached.responder.instanceId = ghost;

      // (a) A CREATING command. `spawn` names a persona that does not exist, so a manager that
      // REACHES the handler refuses it cheaply; no agent is started. The handler entry is still
      // counted, which is what makes "how many times did this run" answerable at all.
      //
      // WHAT MOVED, AND WHY THESE CELLS ARE RE-CUT RATHER THAN RETIRED. The claim they were written
      // for — a caller is never handed the success of a SECOND execution — has not changed and is
      // still asserted below, on the execution counter. What changed is the mechanism that keeps it
      // true, and therefore what the caller sees on the way. These managers now carry the pre-effect
      // fence: the first attempt is REFUSED before the handler, so the split no longer surfaces as a
      // throw the caller must interpret, and the re-issue that follows is a first attempt rather
      // than a second. The old assertions (`SURFACES`, `failed-precondition`, the
      // responder-answered marker) described the only disposition available when a split could only
      // be caught after the fact; they are now the disposition of a caller talking to a responder
      // that predates the fence, which `smoke:unfenced-responder` drives directly and which this
      // fixture can no longer produce — every manager here is fenced.
      const spawnedBefore = totalRuns("spawn");
      let threw: unknown;
      let returned: unknown;
      try {
        returned = await ep.invokeService(MANAGER_ENDPOINT, "spawn", { name: `ghost-${randomUUID().slice(0, 6)}`, agent: "claude" });
      } catch (e) { threw = e; }
      const spawnReply = (returned as { reply?: { ok?: boolean; error?: { code?: string } } } | undefined)?.reply;
      // THE INVARIANT, UNCHANGED AND NOW MEASURED DIRECTLY. It used to be inferred from a publish
      // count; it is now the count of handler entries, which is the property itself.
      check("a CREATING command still runs AT MOST ONCE across the split (execution count, not publish count)",
        totalRuns("spawn") - spawnedBefore <= 1, { ran: totalRuns("spawn") - spawnedBefore, threw, spawnReply });
      // NARROWED, and the narrowing is the fence: this used to assert the call SURFACED. It no
      // longer does, because the refusal arrives before the effect and the client repairs it. The
      // surfacing case is not gone from the world — it is the version-skewed pair, and it is graded
      // in `smoke:unfenced-responder`, not here.
      check("...and it no longer SURFACES to the caller: the fence refused the first attempt before any effect",
        threw === undefined, threw instanceof Error ? threw.message.slice(0, 200) : threw);
      // The old `failed-precondition` cell, re-cut: the code is unchanged, but it now arrives on a
      // REPLY the client acted on rather than on a throw the caller had to. `spawn` on a persona
      // that does not exist is itself a failed-precondition, so the code alone cannot tell the two
      // apart — the marker is what distinguishes them, which is why the next cell exists.
      check("...the re-issue reached a live manager and got that manager's own answer",
        spawnReply?.ok === false && spawnReply.error?.code === "failed-precondition", spawnReply);
      // MOVED, not deleted: the responder-answered marker is what a caller gets from a responder
      // WITHOUT the fence. Asserting its ABSENCE here is the same claim from the other side, and it
      // is what would redden if a manager in this fixture ever stopped fencing.
      check("...and the responder-answered marker is absent, because no responder here answered without fencing",
        !respondedButUnbound(threw)
        && (threw instanceof EpEnvelopeError ? (threw.details ?? []) : []).every((d) => d.kind !== EP_UNBOUND_RESPONDER),
        threw instanceof EpEnvelopeError ? threw.details : threw);
      // ...and the recovery is COUNTED, which is the only reason the split rate stays visible once
      // the client stops handing splits to the operator.
      check("...and the split was counted as recovered, so handling it did not make it unmeasurable",
        ep.splitRecoveryCount >= 1, ep.splitRecoveryCount);

      // (b) THE OTHER SIDE OF THE BOUNDARY, and the reason (a) is a narrow guard rather than a blanket
      // one. A read must still self-heal: in a two-manager space roughly half of all class-queue calls
      // split, so surfacing them all would break `ps` about every other run for nothing; re-running a
      // read duplicates no effect. Without this cell the guard could quietly widen to every command
      // and every assertion above would stay green while ordinary reads started failing.
      // The surfaced split above DROPPED the stale bind (that is part of the contract now: a
      // deliberate re-issue must reach the live incarnation), so re-resolve before forcing again.
      const rewarm = await readTolerant(ep, "re-resolve before the read arm");
      const cached2 = cache.get(MANAGER_ENDPOINT);
      check("the read arm re-resolved after the surfaced split (so its forced split is real)",
        rewarm.ok && cached2 !== undefined, rewarm.last);
      if (cached2) cached2.responder.instanceId = ghost;
      // ONE call, not a tolerant loop: the heal must happen INSIDE invokeService (drop the bind,
      // re-resolve, invoke again). Whether that second invoke then succeeds or splits once more is
      // a coin flip in a two-manager space, so the witness is the cache, which the heal leaves
      // bound to a REAL instance either way; a widened guard would have dropped it and thrown.
      // AND WHICH MECHANISM HEALED IT IS NOW ASSERTED, not left to whichever one happens to be
      // reachable. This cell used to pass because the allowlist let a read be re-issued after the
      // split had already been reported. It passes today because the fence refuses the read before
      // it runs and the client recovers from the refusal — a different mechanism, the same green,
      // and nothing in the suite said so. A cell that silently changes which code it defends keeps
      // its tick while the thing it was written to defend stops being exercised, so the two
      // mechanisms are separated here: this arm asserts the REFUSAL path (the recovery counter
      // moves), and the allowlist path is asserted where it is still reachable — against a
      // responder without a fence, in `smoke:unfenced-responder`.
      const readPubs = pubs(ep);
      const readSplitsBefore = ep.splitRecoveryCount;
      const psBefore = totalRuns("ps");
      let readThrew: unknown;
      let readLanded: { reply?: { ok?: boolean; error?: { code?: string; details?: { kind: string }[] } } } | undefined;
      try { readLanded = await ep.invokeService(MANAGER_ENDPOINT, "ps"); } catch (e) { readThrew = e; }
      const afterRead = cache.get(MANAGER_ENDPOINT)?.responder.instanceId;
      check("a READ with the same forced split self-heals inside ONE call: the guard did not widen",
        afterRead === IID1 || afterRead === IID2, { afterRead, threw: readThrew instanceof Error ? readThrew.message.slice(0, 120) : readThrew });
      check("...and it healed through the REFUSAL, not the allowlist: the recovery counter moved",
        ep.splitRecoveryCount === readSplitsBefore + 1,
        { before: readSplitsBefore, after: ep.splitRecoveryCount });
      // A read is repeat-safe, so a duplicate would be harmless — which is exactly why it is the one
      // place a duplicate could hide. Counted anyway: under the fence the first attempt is refused
      // before the handler, so even here the effect lands once.
      // NOT `=== 1`: the re-issue can split again, so a correct run may end with the read never
      // having run. The claim that IS total is that the reply and the effect agree.
      const readReply = (readThrew === undefined ? readLanded?.reply : undefined);
      check("...and the read's disposition matches its effect: refused ⇒ it never ran, answered ⇒ it ran once",
        readThrew !== undefined || dispositionAgrees(readReply, totalRuns("ps") - psBefore),
        { ran: totalRuns("ps") - psBefore, reply: readReply });
      // A re-resolve is a describe plus the contract-store reads behind it, so the heal is many
      // publishes; the point is that it is MORE than the single publish a held guard leaves.
      check("...and that heal re-issued (more than the one publish a held guard leaves)",
        pubs(ep) - readPubs > 1, { publishes: pubs(ep) - readPubs });
    } finally { await ep.stop().catch(() => {}); }
  }

  // ---- 7. THE BOUNDARY IS "CHANGES ANYTHING", NOT "CREATES SOMETHING" ---------------------------
  // The regression cell for a guard that was WRONG on its first attempt, and the reason the
  // classification is an allowlist. That version withheld the retry only for GOAL_BEARING_COMMANDS
  // (spawn/launch), on the theory that a duplicate only hurts when it creates. Adversarial review
  // produced a measured counterexample: `purge` is not goal-bearing, is not convergent, and its
  // second execution deletes messages published between the two; the manager's handler reaches
  // `clearSpaceHistory`, i.e. a real STREAM.PURGE, so "the first one already deleted everything" is
  // false the moment anyone is still publishing.
  //
  // Two assertions, and they fail for different reasons on purpose. The behavioural one proves the
  // live path surfaces; the classification one proves the ALLOWLIST covers every destructive
  // command in the vocabulary, including ones added after this was written. A denylist would pass
  // the first and quietly fail the second.
  console.log("\n7. a DESTRUCTIVE, non-creating command is retry-unsafe too (the purge counterexample)");
  {
    // Classification first: total over the vocabulary, and it needs no broker at all.
    const safe = (c: string) => isRepeatSafeCommand(MANAGER_ENDPOINT, c);
    check("EVERY manager.admin command is classified retry-unsafe, purge included",
      MANAGER_ADMIN_COMMANDS.every((c) => !safe(c)),
      { admin: MANAGER_ADMIN_COMMANDS, retrySafe: MANAGER_ADMIN_COMMANDS.filter(safe) });
    // NOT `MANAGER_READ_COMMANDS.every(safe)`, and the difference is the point. `models` is in the
    // read GRANT class and is NOT repeat-safe: with `{refresh: true}` it reaches the connector's
    // listModels({refresh}) and, for OpenCode, shells out to `opencode models --refresh`, a
    // provider round-trip that rewrites a cache. Same name, same grant class, opposite answer,
    // decided by an argument the classifier cannot see. Asserting the two vocabularies are equal
    // would re-couple them and re-admit exactly that bug.
    check("...while the manager READS stay retry-safe (the guard did not widen)",
      (["status", "ps", "inspect"] as const).every(safe),
      (["status", "ps", "inspect"] as const).filter((c) => !safe(c)));
    check("...but `models` is NOT repeat-safe: its effect depends on an ARGUMENT, not its name",
      !safe("models"));
    // An unknown command must default to UNSAFE. This is the fail-closed property, and it is the
    // only assertion that goes red if someone re-inverts the guard into a denylist.
    check("...and an unclassified command defaults to retry-UNSAFE, not safe",
      !safe("some-command-nobody-classified"));
    // THE ENDPOINT KEY IS LOAD-BEARING. `invokeService` is endpoint-agnostic, so a flat name list
    // would lend the manager's judgement to any endpoint that happens to reuse a name. A
    // third-party endpoint with its own `ps` must NOT inherit "safe to run twice" from this table.
    check("...and an UNKNOWN endpoint has no repeat-safe commands at all, whatever they are called",
      !isRepeatSafeCommand("some-third-party-endpoint", "ps")
      && !isRepeatSafeCommand("some-third-party-endpoint", "list")
      && !isRepeatSafeCommand("some-third-party-endpoint", "inspect"));
    // ...with exactly one exception, and it is structural rather than a carve-out: `describe` is
    // served by the machinery on every endpoint (SPEC 13.7) and is never a cluster command, so it
    // cannot be redefined into something that mutates.
    check("...except `describe`, which is a read on every endpoint by construction",
      isRepeatSafeCommand("some-third-party-endpoint", "describe"));

    // Behavioural: the same forced split as cell 6, on a command that MUTATES without creating.
    // `purge` is manager.admin, so this needs the admin control tier; the privileged probe above
    // would be refused at the broker and never reach a responder, which would grade nothing.
    const id = newIdentity(); const uid = mintLifecycleUid();
    const ep = new CotalEndpoint({
      space, servers: SERVERS, creds: await mintCreds(auth, id, "control-caller-admin", { lifecycleUid: uid }),
      card: { id: id.id, name: "pin-purge-probe", role: "operator", kind: "endpoint" },
      channels: [], consume: false, registerPresence: false, watchPresence: false, lifecycleUid: uid,
    });
    ep.on("error", () => {});
    await ep.start();
    try {
      // Resolve for real, then doctor the cached responder id (identical to cell 6, because the
      // point is that the COMMAND changed the outcome, nothing else).
      const warm = await readTolerant(ep, "admin warm-up");
      const cache = (ep as unknown as { resolvedServices: Map<string, { responder: { instanceId: string } }> }).resolvedServices;
      const cached = cache.get(MANAGER_ENDPOINT);
      check("the admin probe resolved the manager (without this the cell grades nothing)",
        warm.ok && cached !== undefined, warm.last);
      const ghost = `${"w".repeat(4)}${IID1.slice(4)}`;
      if (cached) cached.responder.instanceId = ghost;

      let threw: unknown;
      let returned: unknown;
      const purgePubs = pubs(ep);
      const purgedBefore = totalRuns("purge");
      const purgeSplitsBefore = ep.splitRecoveryCount;
      try {
        returned = await ep.invokeService(MANAGER_ENDPOINT, "purge", { includeDms: false });
      } catch (e) { threw = e; }
      // THE CLAIM, UNCHANGED SINCE THIS CELL WAS WRITTEN: a destructive, non-convergent command is
      // never applied twice because a call split. `purge` reaches a real STREAM.PURGE, and its
      // second execution deletes messages published between the two, so "the first one already
      // deleted everything" is false the moment anyone is still publishing.
      //
      // WHAT MOVED: how it is measured, and it had to move. This asserted "exactly one publish left
      // the caller", which meant one execution only while a split was caught AFTER the responder
      // handled the request. With the pre-effect fence the first attempt is refused before the
      // handler and the SECOND publish carries the FIRST execution — so the old instrument now
      // reports a correctly repaired call and a duplicated one identically. It is replaced by a
      // count taken where the effect is applied, which is the property itself rather than a proxy
      // for it.
      const purgeReply = (returned as { reply?: { ok?: boolean; error?: { code?: string; details?: { kind: string }[] } } } | undefined)?.reply;
      check("a DESTRUCTIVE non-creating command is NEVER purged twice across the split (handler entries, not publishes)",
        totalRuns("purge") - purgedBefore <= 1, { ran: totalRuns("purge") - purgedBefore, threw });
      check("...and its disposition matches its effect: refused ⇒ nothing was purged, answered ⇒ purged once",
        threw !== undefined || dispositionAgrees(purgeReply, totalRuns("purge") - purgedBefore),
        { ran: totalRuns("purge") - purgedBefore, reply: purgeReply });
      // NARROWED BY THE FENCE: this used to assert the split SURFACED, because after-the-fact
      // detection left the caller nothing better. The refusal arrives before the effect now, so the
      // client repairs it and the operator is not asked to verify anything.
      check("...and it no longer surfaces: the refusal arrived before the effect, so there was nothing to verify",
        threw === undefined, threw instanceof Error ? threw.message.slice(0, 200) : threw);
      check("...carrying no responder-answered marker, because no responder here answered without fencing",
        !respondedButUnbound(threw), threw instanceof Error ? threw.message.slice(0, 200) : threw);
      // NARROWED, and this is the one where the old instrument was not merely stale but INVERTED:
      // a re-issue is now the CORRECT behaviour for a command the allowlist would never repeat, so
      // "exactly one publish" would today be the signature of a client that had STRANDED on its
      // stale bind. What must still hold is that the extra publishes carry no extra effect, which
      // the execution count above states directly.
      check("...and the re-issue DID go out — more than one publish, and every one of them safe",
        pubs(ep) - purgePubs > 1, { publishes: pubs(ep) - purgePubs });
      // GROUP B, NARROWED TO WHAT IT ACTUALLY MEASURES. The claim was: the bind naming a gone
      // incarnation must not survive the call, or every later deliberate call on this long-lived
      // handle reuses it and meets the same refusal forever — permanent, on an endpoint with no
      // repeat-safe command to heal it through. That claim is intact. What is no longer true is the
      // instrument: the cache is not EMPTY, because a re-issue that SUCCEEDED repopulated it with a
      // live record. Empty was only ever the shape of "dropped and not replaced".
      const rebound = cache.get(MANAGER_ENDPOINT)?.responder.instanceId;
      check("...and the stale bind did not survive the call: the handle is bound to a LIVE incarnation, not the ghost",
        rebound === undefined || rebound === IID1 || rebound === IID2, { rebound, ghost });
      check("...and the recovery was counted, so a handled split is still a measurable one",
        ep.splitRecoveryCount === purgeSplitsBefore + 1, { before: purgeSplitsBefore, after: ep.splitRecoveryCount });
      // The narrow-guard version of this code returned a SUCCESS here having purged TWICE. The
      // success is now legitimate and the difference is not visible in the reply at all — only in
      // the execution count above, which is exactly why that count had to exist before this cell
      // could be re-cut.
      check("...and any success it returns is the FIRST execution's, never a second's",
        purgeReply?.ok !== true || totalRuns("purge") - purgedBefore === 1,
        { reply: purgeReply, ran: totalRuns("purge") - purgedBefore });

      // ---- THE INTERLEAVING THAT MADE THE DROP NECESSARY ------------------------------------------
      // A long-lived client resolved instance A; A is replaced; B answers a mutating call; the
      // split surfaces. The operator verifies and DELIBERATELY re-issues. With the bind retained,
      // that re-issue was still bound to A, met the same refusal, and could never reach B; on an
      // endpoint whose commands are all unsafe there was no other way out of it. So: the very next
      // call on this handle must NOT be bound to the ghost any more. It re-resolves and either
      // succeeds or splits against a REAL instance (a coin flip in this fixture, so both are
      // accepted); what it must never do is name the ghost as what it is bound to.
      let again: unknown;
      try { await ep.invokeService(MANAGER_ENDPOINT, "purge", { includeDms: false }); } catch (e) { again = e; }
      const againDetail = (again instanceof EpEnvelopeError ? again.details ?? [] : []).find((d) => d.kind === EP_UNBOUND_RESPONDER);
      check("a DELIBERATE re-issue after the surfaced split is no longer bound to the gone incarnation",
        again === undefined || (againDetail !== undefined && againDetail.boundTo !== ghost),
        { boundTo: againDetail?.boundTo, ghost, threw: again instanceof Error ? again.message.slice(0, 120) : again });

      // ---- THE ENDPOINT KEY REACHES THE GUARD --------------------------------------------------
      // The classifier cells above prove `isRepeatSafeCommand` refuses an unknown endpoint. They
      // do not prove the guard ASKS with the endpoint it was called for: a guard hardcoded to
      // `isRepeatSafeCommand("manager", command)` passes every one of them, and it passed this
      // whole suite. MEASURED: that mutation reported SURVIVED at 38/38, the full baseline. So drive
      // the guard from `invokeService` with a NON-manager endpoint argument and a command the
      // MANAGER classifies repeat-safe (`ps`): the endpoint key is then the only thing standing
      // between "surface" and "retry".
      //
      // Fixture: no third-party service is booted here. The cache is seeded under the third-party
      // name with a copy of the manager's resolved record (whose rails ARE the live manager's), so
      // the request draws a real attributed reply from a real responder that is not the ghost the
      // record binds to. That is exactly the guard's input. The `endpoint` argument, which is what
      // the guard and the cache key read, is the third-party name throughout.
      const third = "pin-third-party";
      // The surfaced splits above dropped the manager bind; re-resolve so there is a record to copy.
      if (cache.get(MANAGER_ENDPOINT) === undefined) await readTolerant(ep, "re-resolve before the third-party seed");
      const mgrRecord = cache.get(MANAGER_ENDPOINT) as (ResolvedService & { responder: { instanceId: string } }) | undefined;
      check("the manager record is cached again (the seed below copies it)", mgrRecord !== undefined);
      if (mgrRecord) cache.set(third, { ...mgrRecord, responder: { ...mgrRecord.responder, instanceId: ghost } });
      let thirdThrew: unknown;
      let thirdReturned: unknown;
      const thirdPubs = pubs(ep);
      const thirdPsBefore = totalRuns("ps");
      try {
        thirdReturned = await ep.invokeService(third, "ps");
      } catch (e) { thirdThrew = e; }
      // RE-CUT, AND THE CONDITION THAT MOVED IT IS WHICH LAYER READS THE ENDPOINT KEY. This asserted
      // the responder-answered marker, because the ALLOWLIST was what stood between "surface" and
      // "retry" and the allowlist is keyed by endpoint. The bind-refusal path is not gated by the
      // allowlist at all, so that is no longer the layer under test here — the RESOLVE is, and it is
      // keyed by endpoint just as load-bearingly: a recovery that looked up "manager" would have
      // re-issued against a live manager under a third-party name. The witness is therefore the
      // endpoint the account NAMES, which is derivable and unforgeable from the fixture.
      const thirdMsg = thirdThrew instanceof Error ? thirdThrew.message : String(thirdThrew);
      check("a manager-safe command name on an UNKNOWN endpoint still surfaces, and names THAT endpoint rather than \"manager\"",
        thirdThrew !== undefined && thirdMsg.includes(third) && !thirdMsg.includes(`${MANAGER_ENDPOINT}.ps`),
        thirdMsg.slice(0, 220));
      check("...and it states the command was not run, which is what makes re-issuing it safe",
        /WAS NOT RUN/.test(thirdMsg)
        && replyRefusedBeforeEffect(thirdThrew instanceof EpEnvelopeError ? thirdThrew.toEpError() : undefined),
        thirdMsg.slice(0, 220));
      // INVERTED, deliberately. This asserted exactly ONE publish, because a re-issue was the defect.
      // A re-issue is now the correct response to a refusal that proves nothing ran, so one publish
      // would today be the signature of a client stranded on its stale bind. What must still hold is
      // that no effect went with the extra publish — the manager's `ps` handler was never entered.
      check("...and the re-issue WAS attempted (more than one publish) while nothing ran for it",
        pubs(ep) - thirdPubs > 1 && totalRuns("ps") === thirdPsBefore,
        { publishes: pubs(ep) - thirdPubs });
      check("...and the unknown endpoint's stale bind was dropped",
        cache.get(third) === undefined, { got: cache.get(third)?.responder.instanceId });
      cache.delete(third);

      // ---- THE CLASSIFIER AND THE GUARD, GRADED TOGETHER ---------------------------------------
      // Everything above this line grades them SEPARATELY: the classification checks call
      // `isRepeatSafeCommand` directly, and the behavioural checks drive the guard with exactly two
      // commands (`spawn` in cell 6, `purge` here). Nothing joined the two, so a guard that ignored
      // the classifier entirely and hardcoded `command === "spawn" || command === "purge"` passed
      // the whole suite. MEASURED, not suspected: that mutation reported SURVIVED at 32/32 marks,
      // the full baseline. The list was proved right and the guard was proved to work twice, and
      // between those two facts sat the thing neither of them checked.
      //
      // A peer lane hit the same class from the other side; its fixture graded the old guard with
      // only the first member of a two-member set, so the second silently lost its protection with
      // nothing going red. Same underlying mistake in both: grading a DECISION through one example
      // of it.
      //
      // So sweep the whole admin vocabulary through the real guard. This is the fail-closed test
      // that matches the fail-closed guard: a command added to `MANAGER_ADMIN_COMMANDS` tomorrow is
      // graded here the day it lands, without anyone remembering to add a cell, and no hardcoded
      // subset of commands can satisfy it.
      //
      // The assertion is the PUBLISH COUNT, not the throw, and that choice is load-bearing. A
      // second invoke can split again and throw the identical error, so "it threw" does not separate
      // "the guard held" from "the retry ran and failed too", roughly a coin flip each time, which
      // would make this cell flaky rather than wrong. The publish count is deterministic: one
      // publish means nothing was re-issued; a retry adds a describe and a second invoke. (An
      // earlier version used the cache as this witness; the guard now DROPS the stale bind on
      // purpose, so the cache can no longer tell "held" from "retried", and the count is the direct
      // measurement anyway.)
      // AND THE SWEEP MUST PROVE IT RAN. The first version of this loop asserted only its witness,
      // and it passed with the guard replaced by a hardcoded `command === "spawn" || command ===
      // "purge"`: SURVIVED at 37/37, the full baseline, twice. The reason is the failure mode this
      // file is otherwise careful about: a command that never reaches a responder re-issues nothing
      // either, so the witness was satisfied by commands that had proved nothing. A vacuous pass
      // and a real pass looked identical.
      //
      // So each iteration must first establish that it actually reached the guard, and only then is
      // the witness meaningful. `notReached` is not a tolerance: it is red, because a command that
      // cannot get there is a hole in the sweep and must be seen rather than absorbed.
      //
      // WHAT THE MARKER PROVES, EXACTLY (narrower than an earlier draft of this comment claimed),
      // which said the responder "received and handled it". It proves the published request drew an
      // ATTRIBUTED REPLY from a responder, which is precisely the guard's own input and therefore
      // exactly the right witness here. It does NOT prove the command executed or that any effect
      // landed: an attributed reply can come from validation, authorization, admission, or a
      // business refusal, and the schema-valid nonsense arguments below deliberately provoke the
      // last of those. So this sweep grades the classifier-to-guard wiring across the vocabulary and
      // nothing more. The `purge` cell above is the separate proof that a real destructive effect
      // runs, and it is the only cell in this file that claims one.
      // Each command needs SCHEMA-VALID arguments or the envelope refuses it before it is ever
      // published, which is precisely how the first version passed vacuously: `{}` fails
      // `required` on all seven, so none of them left the client. The values are deliberately
      // nonsense (no such run, no such attempt) so every handler refuses on business grounds and
      // nothing is launched, resumed, or preserved; refusing is a REPLY, which is all this needs.
      // If a schema gains a required field, `notReached` goes red rather than the cell going quiet.
      const attempt = { attemptId: `no-such-attempt-${randomUUID().slice(0, 8)}` };
      const adminArgs: Record<string, Record<string, unknown>> = {
        launch: { runId: `no-such-run-${randomUUID().slice(0, 8)}`, name: `no-such-agent-${randomUUID().slice(0, 6)}` },
        "resume-preserved": { ...attempt, inventory: {} },
        "commit-resume": attempt,
        "finalize-resume": { ...attempt, durableCommitToken: "no-such-token" },
        "prepare-preservation": attempt,
        "commit-preservation": attempt,
        "abort-preservation": attempt,
      };
      const notReached: string[] = [];
      const ranTwice: string[] = [];
      const mismatched: string[] = [];
      const bindKept: string[] = [];
      for (const command of MANAGER_ADMIN_COMMANDS) {
        if (command === "purge") continue; // already graded above, in full
        // Every surfaced split drops the bind, so re-resolve (a tolerant read) before forcing the
        // ghost again; without a cached record there is nothing to doctor and the call would
        // simply resolve for real.
        if (cache.get(MANAGER_ENDPOINT) === undefined) await readTolerant(ep, `re-resolve before ${command}`);
        const c = cache.get(MANAGER_ENDPOINT);
        if (c) c.responder.instanceId = ghost;
        const ranBefore = totalRuns(command);
        let err: unknown;
        let res: unknown;
        try {
          res = await ep.invokeService(MANAGER_ENDPOINT, command, adminArgs[command] ?? {});
        } catch (e) { err = e; }
        // ORDER MATTERS, and getting it wrong made this cell nondeterministic in the mutated
        // direction. When a guard lets the command through, the retry either succeeds (no error, so
        // no marker) or splits again (marker present), a coin flip per command. Testing the marker
        // first therefore sorted the SAME defect into two different buckets depending on the toss.
        // The publish count is the stronger witness and it is checked first: more than one publish
        // means the command reached a responder AND was re-issued, whichever way the second invoke
        // landed. A missing marker only means "never got there" when exactly one publish went out.
        // RE-CUT WITH THE COUNTER, and the witness had to change because the old one inverted. The
        // publish count used to mean "was it re-issued", and a re-issue used to be the defect. Under
        // the fence the re-issue is the repair and the publish count can no longer separate a
        // repaired call from a duplicated one — only the handler-entry count can.
        const delta = totalRuns(command) - ranBefore;
        const reply = (res as { reply?: { ok?: boolean; error?: { code?: string; details?: { kind: string }[] } } } | undefined)?.reply;
        const refused = replyRefusedBeforeEffect(reply?.error)
          || (err instanceof EpEnvelopeError && replyRefusedBeforeEffect(err.toEpError()));
        // REACHED means the request got as far as a responder: it either ran, or came back refused
        // by one. Neither ⇒ the command never got there and the rest of the loop grades nothing.
        if (!refused && delta === 0) { notReached.push(command); continue; }
        if (delta > 1) ranTwice.push(command);
        if (err === undefined && !dispositionAgrees(reply, delta)) mismatched.push(command);
        if (cache.get(MANAGER_ENDPOINT)?.responder.instanceId === ghost) bindKept.push(command);
      }
      check("every other manager.admin command REACHES the guard (without this the sweep is vacuous)",
        notReached.length === 0, { notReached });
      // WAS: "none of them is quietly retried". A retry was the defect while a split could only be
      // caught after the responder had handled the request. It is now the repair, and the property
      // that replaced it is the one the old cell was protecting all along.
      check("...and NONE of them ran twice, across the whole admin vocabulary (handler entries)",
        ranTwice.length === 0, { ranTwice, checked: MANAGER_ADMIN_COMMANDS.filter((c) => c !== "purge") });
      check("...and every one of their dispositions matched its effect: refused ⇒ it never ran",
        mismatched.length === 0, { mismatched });
      check("...and none is left bound to the gone incarnation (a deliberate re-issue re-resolves)",
        bindKept.length === 0, { bindKept });
    } finally { await ep.stop().catch(() => {}); }
  }

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} finally {
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
