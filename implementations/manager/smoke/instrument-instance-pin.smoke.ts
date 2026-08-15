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
 * the argument dropped anywhere along it. That gap is no longer merely named — it is covered by
 * `cli-on-instance-live.smoke.ts`, which drives the real binary; and it was a real shipped defect,
 * not a hypothetical. Keep the two suites distinct: "the pin works" and "the flag reaches the pin"
 * are different claims, evidenced in different files.
 *
 * Cells 5 and 6 grade the describe's permission watch and the split-retry guard, and both reach
 * into internals on purpose (the transport's status-listener registry; `Endpoint`'s resolved-service
 * cache). Neither has a public accessor, and both guard regressions that every functional assertion
 * in this file would miss — a leaked listener per resolve, and a mutating command executed twice.
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
  instancePinnedInstrumentCapabilities, respondedButUnbound, EP_UNBOUND_RESPONDER, CotalEndpoint,
  isRepeatSafeCommand, MANAGER_ADMIN_COMMANDS,
  type EpCaller,
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
 *  behaviour it is — which is exactly what happened: cell 7's warm-up was written as a bare single
 *  call and went red on an otherwise green sweep. Shared, so the next cell that needs a warm read
 *  cannot quietly reintroduce it. The tolerance is explicit and bounded; it is not a retry loop
 *  hiding a failure, because a genuine break exhausts all six attempts and still reports. */
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
  console.log("\n4. the denied publish is LOUD — a missing grant never reads as an absent responder");
  check("it is reported as permission-denied, NOT a describe deadline",
    noPin.why === "permission-denied", { got: noPin.why, detail: noPin.detail?.slice(0, 200) });
  check("...and it names the subject the credential lacked, so the remedy is readable off the error",
    (noPin.detail ?? "").includes(`.ep.inst.manager.${IID1}.describe.`), noPin.detail?.slice(0, 260));
  check("...and says the responder may be healthy (the wrong conclusion is the expensive one)",
    /REFUSED BY THE BROKER/.test(noPin.detail ?? "") && /grant is what is missing/.test(noPin.detail ?? ""),
    noPin.detail?.slice(0, 260));

  // ---- 5. THE WATCH RELEASES ITSELF ------------------------------------------------------------
  // The permission watch in cell 4 subscribes the connection's status stream. That stream is
  // connection-lived, so a describe that does not RELEASE its listener leaks one per resolve — an
  // unbounded growth on exactly the long-lived connections the mesh runs on, and invisible to every
  // functional assertion above, which is how the first cut of this shipped. `return()` is not
  // enough: the transport's generator parks on an internal signal await, so a queued return does
  // not run until the next status event, which on a healthy connection may never arrive.
  //
  // This reaches into `protocol.listeners` deliberately. The registration is internal and there is
  // no public accessor, so the choice is to assert on the internal or not to assert at all — and
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
  // invoking AGAIN. That was written for one reading of the code — "the describe-bound incarnation
  // is gone, so the first invoke never ran, and a second is a repair". The describe-bound currency
  // check also raises it in a case where that premise is FALSE: a different live instance wins the
  // class queue and REPLIES, so the request was received and executed, and the error is raised
  // afterwards. Re-invoking there executes a mutating command twice — the "one spawn, several
  // seats" shape — while the error text tells the operator not to retry.
  //
  // Made deterministic rather than raced: resolve for real, then doctor the CACHED responder id to
  // an instance that does not exist. Every subsequent class-queue answer is then "not the bound
  // incarnation" on every run, whichever manager wins. Reaching into `resolvedServices` is the
  // point — that cache is what the retry drops, and there is no public way to age it.
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

      // (a) A CREATING command must surface. `spawn` names a persona that does not exist, so the
      // manager refuses it cheaply — no agent is started. What matters is that the request REACHED a
      // responder, which is enough to make a second invoke a second execution. Without the guard the
      // catch drops the cache, re-resolves against a real instance and invokes AGAIN, and that
      // second call is the duplicate; the caller is handed its success and never learns of the split.
      let threw: unknown;
      let returned: unknown;
      try {
        returned = await ep.invokeService(MANAGER_ENDPOINT, "spawn", { name: `ghost-${randomUUID().slice(0, 6)}`, agent: "claude" });
      } catch (e) { threw = e; }
      check("a CREATING command's split SURFACES instead of being swallowed by a second invoke",
        threw !== undefined, { returned: (returned as { reply?: unknown } | undefined)?.reply });
      check("...as failed-precondition", threw instanceof EpEnvelopeError && threw.code === "failed-precondition",
        threw instanceof Error ? threw.message.slice(0, 160) : threw);
      check("...carrying the responder-answered marker, which is what gates the retry",
        respondedButUnbound(threw), threw instanceof Error ? threw.message.slice(0, 200) : threw);
      const detail = (threw instanceof EpEnvelopeError ? threw.details ?? [] : []).find((d) => d.kind === EP_UNBOUND_RESPONDER);
      check("...and the marker names the instance that actually handled it",
        typeof detail?.answeredBy === "string" && (detail.answeredBy === IID1 || detail.answeredBy === IID2),
        detail);

      // (b) THE OTHER SIDE OF THE BOUNDARY, and the reason (a) is a narrow guard rather than a blanket
      // one. A read must still self-heal: in a two-manager space roughly half of all class-queue calls
      // split, so surfacing them all would break `ps` about every other run for nothing — re-running a
      // read duplicates no effect. Without this cell the guard could quietly widen to every command
      // and every assertion above would stay green while ordinary reads started failing.
      const cached2 = cache.get(MANAGER_ENDPOINT);
      if (cached2) cached2.responder.instanceId = ghost;
      const healed = await readTolerant(ep, "read-after-forced-split");
      check("a READ with the same forced split still self-heals — the guard did not widen", healed.ok, healed.last);
    } finally { await ep.stop().catch(() => {}); }
  }

  // ---- 7. THE BOUNDARY IS "CHANGES ANYTHING", NOT "CREATES SOMETHING" ---------------------------
  // The regression cell for a guard that was WRONG on its first attempt, and the reason the
  // classification is an allowlist. That version withheld the retry only for GOAL_BEARING_COMMANDS
  // (spawn/launch), on the theory that a duplicate only hurts when it creates. Adversarial review
  // produced a measured counterexample: `purge` is not goal-bearing, is not convergent, and its
  // second execution deletes messages published between the two — the manager's handler reaches
  // `clearSpaceHistory`, i.e. a real STREAM.PURGE, so "the first one already deleted everything" is
  // false the moment anyone is still publishing.
  //
  // Two assertions, and they fail for different reasons on purpose. The behavioural one proves the
  // live path surfaces; the classification one proves the ALLOWLIST covers every destructive
  // command in the vocabulary, including ones added after this was written. A denylist would pass
  // the first and quietly fail the second.
  console.log("\n7. a DESTRUCTIVE, non-creating command is retry-unsafe too (the purge counterexample)");
  {
    // Classification first — total over the vocabulary, and it needs no broker at all.
    const safe = (c: string) => isRepeatSafeCommand(MANAGER_ENDPOINT, c);
    check("EVERY manager.admin command is classified retry-unsafe, purge included",
      MANAGER_ADMIN_COMMANDS.every((c) => !safe(c)),
      { admin: MANAGER_ADMIN_COMMANDS, retrySafe: MANAGER_ADMIN_COMMANDS.filter(safe) });
    // NOT `MANAGER_READ_COMMANDS.every(safe)`, and the difference is the point. `models` is in the
    // read GRANT class and is NOT repeat-safe: with `{refresh: true}` it reaches the connector's
    // listModels({refresh}) and, for OpenCode, shells out to `opencode models --refresh` — a
    // provider round-trip that rewrites a cache. Same name, same grant class, opposite answer,
    // decided by an argument the classifier cannot see. Asserting the two vocabularies are equal
    // would re-couple them and re-admit exactly that bug.
    check("...while the manager READS stay retry-safe (the guard did not widen)",
      (["status", "ps", "inspect"] as const).every(safe),
      (["status", "ps", "inspect"] as const).filter((c) => !safe(c)));
    check("...but `models` is NOT repeat-safe — its effect depends on an ARGUMENT, not its name",
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

    // Behavioural — the same forced split as cell 6, on a command that MUTATES without creating.
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
      // Resolve for real, then doctor the cached responder id — identical to cell 6, because the
      // point is that the COMMAND changed the outcome, nothing else.
      const warm = await readTolerant(ep, "admin warm-up");
      const cache = (ep as unknown as { resolvedServices: Map<string, { responder: { instanceId: string } }> }).resolvedServices;
      const cached = cache.get(MANAGER_ENDPOINT);
      check("the admin probe resolved the manager (without this the cell grades nothing)",
        warm.ok && cached !== undefined, warm.last);
      const ghost = `${"w".repeat(4)}${IID1.slice(4)}`;
      if (cached) cached.responder.instanceId = ghost;

      let threw: unknown;
      let returned: unknown;
      try {
        returned = await ep.invokeService(MANAGER_ENDPOINT, "purge", { includeDms: false });
      } catch (e) { threw = e; }
      check("a DESTRUCTIVE non-creating command's split SURFACES — it is not purged a second time",
        threw !== undefined, { returned: (returned as { reply?: unknown } | undefined)?.reply });
      check("...carrying the responder-answered marker (so the caller can tell it may already have run)",
        respondedButUnbound(threw), threw instanceof Error ? threw.message.slice(0, 200) : threw);
      // THE GUARD MUST NOT HAVE DROPPED THE CACHE. This is the deterministic half, and it is what
      // makes the sweep below possible. `invokeService` deletes the cached resolve and re-invokes
      // AFTER the guard; so if the guard let this command through, the ghost id is gone and a real
      // instance has taken its place — observable regardless of whether the second invoke then
      // happened to succeed or to split again. Asserting on the throw alone cannot distinguish
      // those, because a second split throws the same error the guard would have thrown.
      check("...and the cached resolve was NOT dropped — the retry never started",
        cache.get(MANAGER_ENDPOINT)?.responder.instanceId === ghost,
        { want: ghost, got: cache.get(MANAGER_ENDPOINT)?.responder.instanceId });
      // The narrow-guard version of this code returned a SUCCESS here, having purged twice. Naming
      // that explicitly so a future reader knows which way this cell fails.
      check("...and does NOT return the second execution's success",
        (returned as { reply?: { ok?: boolean } } | undefined)?.reply?.ok !== true,
        (returned as { reply?: unknown } | undefined)?.reply);

      // ---- THE CLASSIFIER AND THE GUARD, GRADED TOGETHER ---------------------------------------
      // Everything above this line grades them SEPARATELY: the classification checks call
      // `isRepeatSafeCommand` directly, and the behavioural checks drive the guard with exactly two
      // commands (`spawn` in cell 6, `purge` here). Nothing joined the two, so a guard that ignored
      // the classifier entirely and hardcoded `command === "spawn" || command === "purge"` passed
      // the whole suite. MEASURED, not suspected: that mutation reported SURVIVED at 32/32 marks,
      // the full baseline. The list was proved right and the guard was proved to work twice, and
      // between those two facts sat the thing neither of them checked.
      //
      // A peer lane hit the same class from the other side — its fixture graded the old guard with
      // only the first member of a two-member set, so the second silently lost its protection with
      // nothing going red. Same underlying mistake in both: grading a DECISION through one example
      // of it.
      //
      // So sweep the whole admin vocabulary through the real guard. This is the fail-closed test
      // that matches the fail-closed guard: a command added to `MANAGER_ADMIN_COMMANDS` tomorrow is
      // graded here the day it lands, without anyone remembering to add a cell, and no hardcoded
      // subset of commands can satisfy it.
      //
      // The assertion is the CACHE, not the throw, and that choice is load-bearing. A second invoke
      // can split again and throw the identical error, so "it threw" does not separate "the guard
      // held" from "the retry ran and failed too" — roughly a coin flip each time, which would make
      // this cell flaky rather than wrong. The cache is deterministic: `invokeService` drops it only
      // on the path the guard is there to prevent.
      // AND THE SWEEP MUST PROVE IT RAN. The first version of this loop asserted only the cache, and
      // it passed with the guard replaced by a hardcoded `command === "spawn" || command === "purge"`
      // — SURVIVED at 37/37, the full baseline, twice. The reason is the failure mode this file is
      // otherwise careful about: a command that never reaches a responder leaves the cache untouched
      // too, so "the ghost is still cached" was satisfied by commands that had proved nothing. A
      // vacuous pass and a real pass looked identical.
      //
      // So each iteration must first establish that it actually reached the guard — the error came
      // back carrying the responder-answered marker, meaning an instance received and handled it —
      // and only then is the cache meaningful. `notReached` is not a tolerance: it is red, because a
      // command that cannot get there is a hole in the sweep and must be seen rather than absorbed.
      // Each command needs SCHEMA-VALID arguments or the envelope refuses it before it is ever
      // published — which is precisely how the first version passed vacuously: `{}` fails
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
      const retriedAnyway: string[] = [];
      for (const command of MANAGER_ADMIN_COMMANDS) {
        if (command === "purge") continue; // already graded above, in full
        const c = cache.get(MANAGER_ENDPOINT);
        if (c) c.responder.instanceId = ghost; // re-force: a preceding iteration may have healed it
        let err: unknown;
        try {
          await ep.invokeService(MANAGER_ENDPOINT, command, adminArgs[command] ?? {});
        } catch (e) { err = e; }
        if (!respondedButUnbound(err)) { notReached.push(command); continue; }
        if (cache.get(MANAGER_ENDPOINT)?.responder.instanceId !== ghost) retriedAnyway.push(command);
      }
      check("every other manager.admin command REACHES the guard (without this the sweep is vacuous)",
        notReached.length === 0, { notReached });
      check("...and none of them is quietly retried — the guard reads the classifier, not a fixed list",
        retriedAnyway.length === 0,
        { retriedAnyway, checked: MANAGER_ADMIN_COMMANDS.filter((c) => c !== "purge") });
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
