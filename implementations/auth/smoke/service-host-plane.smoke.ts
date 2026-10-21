/** Owned-broker suite for the service endpoint host inside the authority plane. Sections P to W open
 * the real plane (`openAuthAuthorityPlane`) on one JWT-permission broker; section H starts hosted
 * contexts (`startAuthService`) on another. The service name binding, the owner's interactive actor
 * row and the one malformed issuance row are fixture simulations; the smoke-only probes pause or
 * observe the discovery registry and each effect connection, or make an effect's close reject
 * without closing it, `probePlaneDeath` kills a scanner, and section W pauses the owned broker.
 * Nothing here is native, Cloud or production acceptance, and nothing proves a human decision. */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  contractDigest, createEndpointStreams, createSpaceAuth, ensureAuthorityStores, epAuthBucket, isReachable, mintCreds, newIdentity, serverConfig,
  setupSpaceStreams, type EvictionResult,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAuthorityClient } from "../src/authority-client.js";
import type { EvictPrincipal } from "../src/credential-ledger.js";
import * as index from "../src/index.js";
import { grantActor } from "../src/ledger.js";
import { openLifecycleRegistry, registryStores, type LifecycleRegistry } from "../src/lifecycle-registry.js";
import { bindNativeServiceName } from "../src/native-service-name.js";
import { parsePlaneClaimRow, PLANE_CLAIM_KEY, type PlaneLivenessOracle } from "../src/plane-claim.js";
import type { ServiceEndpointHost, ServiceHostRequest, ServiceHostResult } from "../src/service-host-contract.js";
import { serviceHostOperationId, type ServiceHostEffect } from "../src/service-host-ops.js";
import { openAuthAuthorityPlane, serviceHostEngineOf, startAuthService, type AuthAuthorityPlane, type AuthServiceHandle, type OpenAuthAuthorityPlaneOptions } from "../src/service.js";
import { checks, within } from "./_service-custody-fixture.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const c = checks();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => randomBytes(16).toString("hex");
const D = (s: string) => contractDigest({ fixture: s });
const command = { name: "lookup", clusterDigest: D("cluster"), class: "ephemeral", targeted: false, modes: [], capability: "read", inputDigest: D("in"), outputDigest: D("out"), traits: [] };
const owner = `u_${"c".repeat(26)}`, endpoint = "org.example.recovery";
const quiet = () => {};
const rejects = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ""; } catch (e) { return (e as Error)?.message ?? String(e); } };
const call = (host: ServiceEndpointHost, req: object): Promise<ServiceHostResult> => host(req as ServiceHostRequest);
const settled = <T>(p: Promise<T>) => { const s = { done: false }; p.then(() => { s.done = true; }, () => { s.done = true; }); return s; };
/** Whether `p` settles within `ms`; unlike `within`, it tells a void resolution from a timeout. */
const settlesWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true, () => true), wait(ms).then(() => false)]);
/** A gate the probe awaits until the test opens it. */
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

const reg = (instanceId: string, requestId = rid()) => ({
  v: 1, kind: "service-endpoint-host", requestId, operation: "register",
  input: { owner, endpoint, instanceId, clusterDigests: [D("cluster")], commands: [command] }, granter: { kind: "owner", owner },
});
const decide = (proposalId: string, rev: number, nameRev: number, requestId = rid()) => ({
  v: 1, kind: "service-endpoint-host", requestId, operation: "decide", granter: { kind: "owner", owner },
  input: { proposalId, expectedProposalRevision: rev, expectedNameRevision: nameRev, decision: "approve", callerCeiling: [] },
});
const revoke = (instanceId: string, digest: string) => ({
  v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: { kind: "owner", owner },
  input: { endpoint, instanceId, expectedAssignmentDigest: digest, cause: "owner-request" },
});
const opRead = (operationId: string) => ({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "operation-read", input: { operationId }, granter: { kind: "operator", auditId: "fixture-operator" } });
const latched = (r: ServiceHostResult) => r.state === "held" && r.reason === "readiness" && r.phase === "open";

// ---- the plane broker -------------------------------------------------------------------------
const PORT = await pickFreePort();
if (PORT === 4222) throw new Error("this suite refuses the default NATS port");
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `svhp-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
let up = false;
for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

// A wide harness connection: store setup (production space setup stands in), the simulated name
// binding and every raw read below.
const wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
await ensureAuthorityStores(await jetstreamManager(wide.nc), new Kvm(wide.nc), space);
await createEndpointStreams(await jetstreamManager(wide.nc), new Kvm(wide.nc), space);
const wideKv = await new Kvm(wide.nc).open(epAuthBucket(space));
const dec = new TextDecoder();
const value = async (key: string) => { const e = await wideKv.get(key); return e && e.operation === "PUT" ? JSON.parse(dec.decode(e.value)) as Record<string, unknown> : null; };
const revision = async (key: string) => (await wideKv.get(key))?.revision ?? 0;
const claimState = async () => parsePlaneClaimRow((await wideKv.get(PLANE_CLAIM_KEY))!.value)?.state;
// Simulation: the name binding a verified namespace claim would write, and the owner's CLI actor row.
const name = await bindNativeServiceName(await openLifecycleRegistry(wide.nc, space), { accountPublicKey: dataAccount.pub, space }, {
  v: 1, kind: "service-endpoint-host", requestId: "c".repeat(32), operation: "name-bind",
  granter: { kind: "operator", auditId: "fixture-verified-claim" }, input: { endpoint, owner, expectedRevision: 0, claimReference: "fixture-namespace-claim" },
});
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
grantActor(dir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });

const okEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult);
const neverOracle: PlaneLivenessOracle = async () => { throw new Error("the oracle must not be consulted on a created or released claim"); };
interface Opened { plane: AuthAuthorityPlane; logs: string[]; kills?: { ledger: () => Promise<void>; records: () => Promise<void> }; effects: number; discoveries: number }
/** One plane over the released claim, with its probes routed to `hooks`. */
async function openPlane(over: Partial<OpenAuthAuthorityPlaneOptions> = {}, hooks: {
  discovery?: (d: { registry: LifecycleRegistry; kill: () => Promise<void> }, o: Opened) => void | Promise<void>;
  effect?: (e: ServiceHostEffect, o: Opened) => void | Promise<void>;
} = {}): Promise<Opened> {
  const o = { logs: [] as string[], effects: 0, discoveries: 0 } as Opened;
  o.plane = await openAuthAuthorityPlane({
    server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: (l) => o.logs.push(l),
    probeEvictor: okEvictor, probePlaneOracle: neverOracle, probePlaneDeath: (k) => { o.kills = k; },
    probeServiceHost: {
      discovery: async (d) => { o.discoveries++; await hooks.discovery?.(d, o); },
      effect: async (e) => { o.effects++; await hooks.effect?.(e, o); },
    },
    ...over,
  });
  return o;
}
const enabled = { serviceEndpoints: { startup: { kind: "normal" as const } } };
const died = async (o: Opened) => { for (let i = 0; i < 50 && !o.logs.some((l) => l.includes("STOPPED scanning")); i++) await wait(100); return o.logs.some((l) => l.includes("STOPPED scanning")); };
/** A registered proposal, through the package-internal register admission. */
async function registered(host: ServiceEndpointHost, instanceId = rid()) {
  const r = await serviceHostEngineOf(host)!.register(reg(instanceId));
  if (r.state !== "registered") throw new Error(`fixture register failed: ${JSON.stringify(r)}`);
  return { ...r, instanceId };
}

try {
  // ---- P: default off ---------------------------------------------------------------------------
  {
    const o = await openPlane();
    c.check("P1 without serviceEndpoints the plane has no service endpoint host", o.plane.serviceEndpointHost === undefined && !("serviceEndpointHost" in o.plane));
    c.check("P1 no discovery registry and no effect were opened", o.discoveries === 0 && o.effects === 0, o);
    c.check("P1 no svchost.admission row was written", (await wideKv.get("svchost.admission")) === null);
    await o.plane.close();
    c.check("P1 close releases the claim", (await claimState()) === "released");
  }

  // ---- S: startup refusal and unwind --------------------------------------------------------------
  for (const [label, startup, re] of [
    ["S1 a restore startup", { kind: "restore", restoreId: "fixture-restore" }, /restore startup is not supported/],
    ["S2 a missing startup", undefined, /explicit startup kind/],
  ] as const) {
    let registry: LifecycleRegistry | undefined;
    const msg = await rejects(() => openPlane({ serviceEndpoints: { startup } as never }, { discovery: (d) => { registry = d.registry; } }));
    c.check(`${label} refuses the whole plane open`, re.test(msg), msg);
    c.check(`${label}: the unwind released the claim`, (await claimState()) === "released");
    const read = registry ? await rejects(() => registryStores(registry!).authKv.get("svchost.admission")) : "no registry";
    c.check(`${label}: the unwind closed the discovery connection`, /clos/i.test(read), read);
    c.check(`${label}: no svchost.admission row was written`, (await wideKv.get("svchost.admission")) === null);
  }

  // ---- R: the real host ---------------------------------------------------------------------------
  {
    const o = await openPlane(enabled);
    const host = o.plane.serviceEndpointHost!;
    c.check("R1 a normal startup opens the host on the plane", typeof host === "function" && o.discoveries === 1);
    c.check("R1 startup created admission open at epoch 1", JSON.stringify(await value("svchost.admission")) === JSON.stringify({ v: 1, kind: "service-host-admission", state: "open", epoch: 1, restoreId: null }));
    c.check("R1 the engine behind the host is package-internal: the index exports neither it nor its accessor",
      serviceHostEngineOf(host) !== undefined && !("serviceHostEngineOf" in index) && !("openServiceHostOperations" in index) && serviceHostEngineOf((async () => ({})) as never) === undefined);
    c.check("R1 the host exposes no register operation", Object.keys(host).length === 0);
    const p = await registered(host);
    const req = decide(p.proposalId, p.revision, name.revision);
    const r1 = await call(host, req);
    c.check("R2 approve through the plane's host completes (applied)", r1.state === "approved" && r1.outcome === "applied", r1);
    const approval = r1.state === "approved" ? r1.approval : undefined;
    c.check("R2 the invocation used its own effect connection", o.effects >= 2, o.effects);
    const rv = await call(host, revoke(p.instanceId, approval?.assignment.assignmentDigest ?? ""));
    c.check("R3 revoke through the host lands deny-new and stays nonterminal", rv.state === "pending" && rv.phase === "cancelled-nonterminal" && rv.denyNew === "landed", rv);
    const or = await call(host, opRead(serviceHostOperationId(space, req.requestId)));
    c.check("R4 operator operation-read sees the approval's operation", or.state === "present", or);
    const pr = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId: p.proposalId }, granter: { kind: "owner", owner } });
    c.check("R4 owner proposal-read sees the terminal view", pr.state === "present", pr);
    const u = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "instance-read", input: { endpoint, instanceId: p.instanceId }, granter: { kind: "owner", owner } });
    c.check("R5 operations outside decide, revoke and the reads are unsupported", u.state === "denied" && u.reason === "unsupported", u);
    await o.plane.close();
    c.check("R6 close releases the claim", (await claimState()) === "released");
    const after = await call(host, decide(p.proposalId, p.revision, name.revision));
    c.check("R6 a closed host answers the latch, before any read", latched(after), after);
  }

  // ---- L: discovery loss --------------------------------------------------------------------------
  {
    let kill: (() => Promise<void>) | undefined;
    const o = await openPlane(enabled, { discovery: (d) => { kill = d.kill; } });
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    const propRev = await revision(`svcprop.${p.proposalId}`);
    await kill!();
    const effectsBefore = o.effects;
    const req = decide(p.proposalId, p.revision, name.revision);
    const r = await call(host, req);
    c.check("L1 with discovery closed, decide answers unavailable", (r.state === "denied" && r.reason === "unavailable") || (r.state === "held" && r.reason === "unavailable"), r);
    c.check("L1 nothing was written: no binding, the proposal unchanged, no effect opened",
      (await wideKv.get(`svcop.${serviceHostOperationId(space, req.requestId)}`)) === null && (await revision(`svcprop.${p.proposalId}`)) === propRev && o.effects === effectsBefore);
    const rr = await call(host, opRead(serviceHostOperationId(space, req.requestId)));
    c.check("L2 reads answer unavailable too", rr.state === "denied" && rr.reason === "unavailable", rr);
    c.check("L3 the plane itself stays up: no fatal", (await within(o.plane.fenced, 500)) === undefined);
    await o.plane.close();
    c.check("L4 close after the loss releases the claim", (await claimState()) === "released");
  }

  // ---- O: fatal during an invocation ---------------------------------------------------------------
  {
    // O1: the fatal lands after the effect connection opened and before its first use.
    let armed = false;
    const o = await openPlane(enabled, { effect: async (_e, self) => { if (!armed) return; armed = false; await self.kills!.ledger(); await died(self); } });
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    const propRev = await revision(`svcprop.${p.proposalId}`);
    armed = true;
    const req = decide(p.proposalId, p.revision, name.revision);
    const r = await call(host, req);
    c.check("O1 a fatal between effect open and first use holds the bound decide under its operation", r.state === "held" && r.operationId === serviceHostOperationId(space, req.requestId) && r.reason === "readiness", r);
    c.check("O1 nothing was written", (await wideKv.get(`svcop.${serviceHostOperationId(space, req.requestId)}`)) === null && (await revision(`svcprop.${p.proposalId}`)) === propRev);
    const later = await call(host, decide(p.proposalId, p.revision, name.revision));
    c.check("O1 the scanner death tripped the engine latch: a later call holds at open, before any read", latched(later), later);
    await o.plane.close();
    c.check("O1 the fenced plane still releases its claim on close", (await claimState()) === "released");
  }
  {
    // O2: the fatal lands right after the binding create, before the writer's post-write check.
    let armed = false;
    const o = await openPlane(enabled, {
      effect: (e, self) => {
        if (!armed) return;
        armed = false;
        const kv = registryStores(e.registry).authKv, put = kv.put.bind(kv);
        let first = true;
        kv.put = (async (...args: Parameters<typeof put>) => {
          const out = await put(...args);
          if (first) { first = false; await self.kills!.ledger(); await died(self); }
          return out;
        }) as typeof kv.put;
      },
    });
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    const propRev = await revision(`svcprop.${p.proposalId}`);
    armed = true;
    const req = decide(p.proposalId, p.revision, name.revision);
    const r = await call(host, req);
    c.check("O2 a fatal during the first write reports held under the bound operation", r.state === "held" && r.operationId === serviceHostOperationId(space, req.requestId), r);
    c.check("O2 the landed binding stays and nothing after it was written", (await wideKv.get(`svcop.${serviceHostOperationId(space, req.requestId)}`)) !== null && (await revision(`svcprop.${p.proposalId}`)) === propRev);
    const later = await call(host, decide(p.proposalId, p.revision, name.revision));
    c.check("O2 a later call holds at open", latched(later), later);
    await o.plane.close();
    c.check("O2 close releases the claim", (await claimState()) === "released");
  }
  {
    // O3: the second fatal site (a failed native-issuance cleanup), then a scanner death: two trips.
    const o = await openPlane({ ...enabled, nativeIssuancePruneMs: 200 });
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    // Simulation: one malformed issuance row, which the next cleanup pass refuses.
    await wideKv.create("natkey.not-a-user-key", new TextEncoder().encode("{}"));
    const first = await within(o.plane.fenced, 5000);
    c.check("O3 a failed native-issuance cleanup is fatal for the plane", first?.includes("native-issuance cleanup failed") === true, first);
    const r1 = await call(host, decide(p.proposalId, p.revision, name.revision));
    const or1 = await call(host, opRead(serviceHostOperationId(space, rid())));
    c.check("O3 the cleanup failure tripped the engine: decide holds at open and a read is unavailable", latched(r1) && or1.state === "denied" && or1.reason === "unavailable", { r1, or1 });
    await o.kills!.ledger();
    c.check("O3 a scanner death then trips it a second time", await died(o));
    const r2 = await call(host, decide(p.proposalId, p.revision, name.revision));
    c.check("O3 after the second trip the answer is the same latch, and the plane's fatal reason is still the first", latched(r2) && (await o.plane.fenced) === first, r2);
    await wideKv.delete("natkey.not-a-user-key");
    await o.plane.close();
    c.check("O3 close releases the claim", (await claimState()) === "released");
  }
  {
    // O4: a fatal while the host is still opening: the plane latches it once the host exists.
    const o = await openPlane(enabled, { discovery: async (_d, self) => { await self.kills!.ledger(); await died(self); } }).catch((e: unknown) => e as Error);
    if (o instanceof Error) {
      c.check("O4 a fatal while the host opens refuses the open", /STOPPED|fenced|unavailable/i.test(o.message), o.message);
      c.check("O4 the refused open released the claim", (await claimState()) === "released");
    } else {
      const host = o.plane.serviceEndpointHost!;
      const or = await call(host, opRead(serviceHostOperationId(space, rid())));
      const d = await call(host, decide(rid() + rid(), 1, name.revision));
      c.check("O4 a fatal that landed while the host opened latches it after construction", or.state === "denied" && or.reason === "unavailable" && latched(d), { or, d });
      await o.plane.close();
      c.check("O4 close releases the claim", (await claimState()) === "released");
    }
  }

  // ---- C: close with invocations in flight -------------------------------------------------------
  for (const at of ["effect-open", "discovery-read"] as const) {
    const g = gate();
    let paused = false, armed = false;
    const o = await openPlane(enabled, {
      discovery: (d) => {
        if (at !== "discovery-read") return;
        const streams = registryStores(d.registry).jsm.streams, get = streams.getMessage.bind(streams);
        streams.getMessage = (async (...args: Parameters<typeof get>) => {
          if (armed) { armed = false; paused = true; await g.p; }
          return get(...args);
        }) as typeof streams.getMessage;
      },
      effect: async () => { if (at === "effect-open" && armed) { armed = false; paused = true; await g.p; } },
    });
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    armed = true;
    const inflight = call(host, decide(p.proposalId, p.revision, name.revision));
    const s = settled(inflight);
    for (let i = 0; i < 50 && !paused; i++) await wait(20);
    const closing = o.plane.close(), cs = settled(closing);
    await wait(300);
    c.check(`C-${at} the invocation is paused and close waits for it`, paused && !s.done && !cs.done, { paused, s, cs });
    c.check(`C-${at} the claim stays held while the invocation is in flight`, (await claimState()) === "held");
    const fresh = await call(host, decide(p.proposalId, p.revision, name.revision));
    const freshRead = await call(host, opRead(serviceHostOperationId(space, rid())));
    c.check(`C-${at} a call after close began is refused by the latch`, latched(fresh) && freshRead.state === "denied" && freshRead.reason === "unavailable", { fresh, freshRead });
    g.open();
    const r = await inflight;
    c.check(`C-${at} the in-flight decide completes under its own limit`, r.state === "approved", r);
    await closing;
    c.check(`C-${at} close settles only after the invocation, then releases the claim`, s.done && (await claimState()) === "released");
  }

  // ---- E: an effect connection whose close fails ------------------------------------------------
  for (const at of ["before-close", "during-drain"] as const) {
    // The probe makes the armed effect's close reject without closing it while `failing` is set.
    const g = gate();
    let armed = false, failing = false, paused = false, attempts = 0, target: ServiceHostEffect | undefined;
    const o = await openPlane(enabled, {
      effect: async (e) => {
        if (!armed) return;
        armed = false;
        target = e;
        const close = e.close;
        e.close = async () => { attempts++; if (failing) throw new Error("fixture: injected effect close rejection"); await close(); };
        if (at === "during-drain") { paused = true; await g.p; }
      },
    });
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    armed = true; failing = true;
    const inflight = call(host, decide(p.proposalId, p.revision, name.revision)).then(() => "", (e: unknown) => (e as Error).message);
    let first: Promise<string>;
    if (at === "during-drain") {
      for (let i = 0; i < 50 && !paused; i++) await wait(20);
      first = rejects(() => o.plane.close());
      await wait(200);
      g.open();
    } else {
      await inflight;
      first = rejects(() => o.plane.close());
    }
    const callErr = await inflight, firstErr = await first;
    c.check(`E-${at} the call whose effect close failed rejects with that failure`, callErr.includes("injected effect close rejection"), callErr);
    c.check(`E-${at} plane close rejects while that effect is still open`, firstErr.includes("did not close") && attempts === 2, { firstErr, attempts });
    c.check(`E-${at} the effect connection is still open and the claim is still held`, !(await settlesWithin(target!.gone, 200)) && (await claimState()) === "held");
    const refused = await call(host, opRead(serviceHostOperationId(space, rid())));
    c.check(`E-${at} the host stays refused after the failed close`, refused.state === "denied" && refused.reason === "unavailable", refused);
    failing = false;
    const retry = await rejects(() => o.plane.close());
    c.check(`E-${at} a retried close closes the effect, then releases the claim`, retry === "" && attempts === 3 && (await settlesWithin(target!.gone, 2000))
      && (await claimState()) === "released", { retry, attempts });
  }
  {
    // E3: ordinary request errors do not affect close.
    const o = await openPlane(enabled);
    const host = o.plane.serviceEndpointHost!;
    const bad = await rejects(() => call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner }, input: {} }));
    const wrong = await rejects(() => serviceHostEngineOf(host)!.register({ v: 1 }));
    c.check("E3 malformed decide and register requests reject", bad !== "" && wrong !== "", { bad, wrong });
    const closed = await rejects(() => o.plane.close());
    c.check("E3 close after rejected requests succeeds and releases the claim", closed === "" && (await claimState()) === "released", closed);
  }

  // ---- W: refusal from the moment close begins ---------------------------------------------------
  {
    const o = await openPlane(enabled);
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    const propRev = await revision(`svcprop.${p.proposalId}`);
    const effects = o.effects;
    const closing = o.plane.close();
    const d = call(host, decide(p.proposalId, p.revision, name.revision)), r = call(host, opRead(serviceHostOperationId(space, rid())));
    const [dr, rr] = [await d, await r];
    c.check("W1 a decide issued in the same turn as close() answers the latch", latched(dr), dr);
    c.check("W1 a read issued in the same turn as close() answers unavailable", rr.state === "denied" && rr.reason === "unavailable", rr);
    await closing;
    c.check("W1 nothing was written or opened for them, and close released the claim", (await revision(`svcprop.${p.proposalId}`)) === propRev && o.effects === effects && (await claimState()) === "released");
  }
  {
    // W2: close is held open by a prune pass on the paused owned broker; calls in that window refuse.
    const o = await openPlane({ ...enabled, nativeIssuancePruneMs: 100 });
    const host = o.plane.serviceEndpointHost!;
    const p = await registered(host);
    const effects = o.effects;
    srv.kill("SIGSTOP");
    let resumed = false;
    try {
      await wait(300);
      const closing = o.plane.close(), cs = settled(closing);
      await wait(200);
      const d = await within(call(host, decide(p.proposalId, p.revision, name.revision)), 500);
      const r = await within(call(host, opRead(serviceHostOperationId(space, rid()))), 500);
      c.check("W2 while close waits on the paused broker, a decide answers the latch at once", !cs.done && d !== undefined && latched(d), { d, closeDone: cs.done });
      c.check("W2 and a read answers unavailable at once", r !== undefined && r.state === "denied" && r.reason === "unavailable", r);
      srv.kill("SIGCONT"); resumed = true;
      await closing;
      c.check("W2 after the broker resumes close releases the claim, with no effect opened for those calls", o.effects === effects && (await claimState()) === "released");
    } finally { if (!resumed) srv.kill("SIGCONT"); }
  }
} finally {
  await wide.close().catch(() => {});
  srv.kill("SIGCONT");
  srv.kill("SIGTERM");
  if (srv.exitCode === null && srv.signalCode === null) await new Promise<void>((r) => { srv.once("exit", () => r()); setTimeout(r, 3000); });
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker();
}

// ---- H: the hosted context ------------------------------------------------------------------------
{
  const fx = await startHostedAuthFixture("svhost", 1);
  const handles: AuthServiceHandle[] = [];
  try {
    const [a] = fx.accounts;
    await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
    const inputs = { context: { accountPublicKey: a.accountPublicKey, lifecycleUid: "life-0" }, space: a.space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.stateDir };
    const raw = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! }, label: `harness:${a.space}`,
      grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
    const kv = await new Kvm(raw.nc).open(epAuthBucket(a.space));
    const svc = (h: AuthServiceHandle) => h.connections().filter((x) => x.label.startsWith("cotal:service-host-"));
    try {
      const off = await startAuthService(inputs);
      handles.push(off);
      c.check("H1 a hosted context without serviceEndpoints has no host member", off.serviceEndpointHost === undefined && !("serviceEndpointHost" in off));
      c.check("H1 it opens no service host connection and writes no admission row", svc(off).length === 0 && (await kv.get("svchost.admission")) === null, svc(off));
      await off.close();
      const refused = await rejects(() => startAuthService({ ...inputs, serviceEndpoints: { startup: { kind: "restore", restoreId: "fixture-restore" } } }));
      c.check("H2 a restore startup refuses the hosted start", /restore startup is not supported/.test(refused), refused);
      const on = await startAuthService({ ...inputs, serviceEndpoints: { startup: { kind: "normal" } } });
      handles.push(on);
      c.check("H2 a later normal start succeeds: the refused start released its claim", (await on.readiness()).state === "ready");
      const host = on.serviceEndpointHost!;
      c.check("H3 the hosted handle carries the host and its discovery connection is live", typeof host === "function"
        && svc(on).some((x) => x.label === `cotal:service-host-discovery:${a.space}` && !x.ended), svc(on));
      c.check("H3 the hosted door maps to an engine for the internal accessor, and the index exports no accessor", serviceHostEngineOf(host) !== undefined && !("serviceHostEngineOf" in index));
      const or = await call(host, opRead(serviceHostOperationId(a.space, rid())));
      c.check("H4 an operator read through the hosted door reaches the engine", or.state === "absent", or);
      c.check("H4 admission is open at epoch 1", (await kv.get("svchost.admission")) !== null);
      const closing = on.close();
      const during = await rejects(() => call(host, opRead(serviceHostOperationId(a.space, rid()))));
      c.check("H5 the hosted door refuses unavailable once the context is closing", /not ready/.test(during), during);
      await closing;
      c.check("H5 after close every service host connection has ended", svc(on).length > 0 && svc(on).every((x) => x.ended), svc(on));
    } finally { await raw.close().catch(() => {}); }
  } finally {
    for (const h of handles) await h.close().catch(() => {});
    await fx.close();
  }
}

console.log(c.failed === 0 ? `\nSERVICE HOST PLANE SMOKE OK (${c.passed} passed)` : `\nSERVICE HOST PLANE SMOKE FAILED (${c.passed} passed, ${c.failed} failed)`);
if (c.failed > 0) process.exit(1);
