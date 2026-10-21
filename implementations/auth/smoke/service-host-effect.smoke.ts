/** Owned-broker suite for the service host EFFECT credential and its discovery grant, in operator
 * mode through the custody fixture. A loopback TCP relay between a client and the broker counts
 * every connection, keeps the user JWT each CONNECT presents, and can reset every live socket, so
 * the minted claims, the absence of a reconnect and an abrupt socket loss are observed on the wire.
 * Records a test writes directly are labelled as simulations; nothing here is native, Cloud or
 * production acceptance. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as tcp, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, jwtAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { decode, encodeUser } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  EpEnvelopeError, contractDigest, epAuthBucket, epgateKey, lifecycleHeadKey, mintLifecycleUid, recordsBucket, serviceEndpointActor, uidReservationKey,
} from "@cotal-ai/core";
import {
  SERVICE_HOST_INVOCATION_MS, openAuthorityClient, serviceHostDiscoveryGrants, serviceHostEffectGrants, serviceHostEffectLabel, type AuthorityClientOpts,
} from "../src/authority-client.js";
import { grantActor } from "../src/ledger.js";
import { registryStores } from "../src/lifecycle-registry.js";
import {
  S2A_INVOCATION_MS, openServiceHostEffect, openServiceHostOperations, serviceHostOperationId, serviceHostScopeKeys,
  type ServiceHostEffectScope, type ServiceHostOperations, type ServiceHostOperationsOptions,
} from "../src/service-host-ops.js";
import type { ServiceWriteScope } from "../src/service-write.js";
import { bytesOf, checks, openFixture, within, type Fixture, type WriteCall } from "./_service-custody-fixture.js";

const c = checks();
const rid = () => randomBytes(16).toString("hex");
const hex = (n: number) => randomBytes(n / 2).toString("hex");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sorted = (a: readonly string[]) => JSON.stringify([...a].sort());
const ledgers: string[] = [];
const relays: Relay[] = [];

interface Relay { url: string; jwts: string[]; readonly accepted: number; cut(): void; close(): Promise<void> }
/** A loopback relay to `target`: counts accepted connections, keeps each CONNECT's user JWT, and
 *  resets every live socket on `cut`. `silent` accepts and never forwards (a broker that hangs). */
async function relay(target: string, silent = false): Promise<Relay> {
  const port = Number(new URL(target).port);
  const live = new Set<Socket>(), jwts: string[] = [];
  let accepted = 0;
  const server = createServer((client) => {
    accepted++;
    live.add(client);
    client.on("error", () => {});
    client.on("close", () => live.delete(client));
    if (silent) return;
    const upstream = tcp(port, "127.0.0.1");
    live.add(upstream);
    let head: string | null = "";
    client.on("data", (b: Buffer) => {
      if (head === null) return;
      head += b.toString("latin1");
      const m = /CONNECT (\{.*?\})\r\n/.exec(head);
      if (m) { const jwt = (JSON.parse(m[1]!) as { jwt?: unknown }).jwt; if (typeof jwt === "string") jwts.push(jwt); head = null; }
    });
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.on("error", () => {});
    upstream.on("close", () => { live.delete(upstream); client.destroy(); });
    client.on("close", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const own = (server.address() as AddressInfo).port;
  if (own === 4222) throw new Error("the relay refuses the default NATS port");
  const r: Relay = {
    url: `nats://127.0.0.1:${own}`, jwts,
    get accepted() { return accepted; },
    cut() { for (const s of live) s.resetAndDestroy(); },
    close: () => new Promise<void>((done) => { for (const s of live) s.destroy(); server.close(() => done()); }),
  };
  relays.push(r);
  return r;
}
type Claims = { exp?: number; iat: number; name: string; sub: string; nats: { pub?: { allow?: string[] }; sub?: { allow?: string[] } } };
const claimsOf = (jwt: string) => decode(jwt) as unknown as Claims;

const ledger = (owner: string) => {
  const dir = mkdtempSync(join(tmpdir(), "s2a-effect-ledger-"));
  ledgers.push(dir);
  grantActor(dir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  return dir;
};
const D = (s: string) => contractDigest({ fixture: s });
async function engine(f: Fixture, dir: string, d: { registry: ServiceHostOperationsOptions["discovery"] }, over: Partial<ServiceHostOperationsOptions> = {}): Promise<ServiceHostOperations> {
  return openServiceHostOperations({ discovery: d.registry, openEffect: (scope) => f.effect(scope.keys, scope.deadlineMs), hold: f.hold,
    accountPublicKey: f.accountPublicKey, ledgerDir: dir, startup: { kind: "normal" }, ...over });
}
const register = async (f: Fixture, e: ServiceHostOperations, clusterDigest: string) => {
  const instanceId = rid();
  const r = await e.register({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "register", granter: { kind: "owner", owner: f.owner },
    input: { owner: f.owner, endpoint: f.endpoint, instanceId, clusterDigests: [clusterDigest],
      commands: [{ name: "lookup", clusterDigest, class: "ephemeral", targeted: false, modes: [], capability: "read", inputDigest: clusterDigest, outputDigest: clusterDigest, traits: [] }] } });
  if (r.state !== "registered") throw new Error(`fixture register failed: ${JSON.stringify(r)}`);
  return { ...r, instanceId };
};
const approve = (f: Fixture, p: { proposalId: string; revision: number }, requestId = rid()) => ({
  v: 1, kind: "service-endpoint-host", requestId, operation: "decide", granter: { kind: "owner", owner: f.owner },
  input: { proposalId: p.proposalId, expectedProposalRevision: p.revision, expectedNameRevision: f.name.revision, decision: "approve", callerCeiling: [] },
});
const revoke = (f: Fixture, instanceId: string, digest: string) => ({
  v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: { kind: "owner", owner: f.owner },
  input: { endpoint: f.endpoint, instanceId, expectedAssignmentDigest: digest, cause: "owner-request" },
});
type Loose = { state: string; reason?: string; phase?: string; operationId?: string; approval?: { assignment: { lifecycleUid: string; assignmentDigest: string } } };
const L = (r: unknown) => r as Loose;

// ---- G: the grants and the profile guard -------------------------------------------------------
{
  const f = await openFixture("s2a-effect-grants", { limited: true });
  try {
    const u = mintLifecycleUid(), instanceId = rid(), op = hex(32), proposal = hex(64);
    const target = { operation: "decide" as const, operationId: op, proposalId: proposal, owner: f.owner, endpoint: f.endpoint, instanceId, lifecycleUid: u };
    const keys = serviceHostScopeKeys({ accountPublicKey: f.accountPublicKey, space: f.space }, target);
    const id = createUser().getPublicKey();
    const disc = serviceHostDiscoveryGrants(f.space, id), eff = serviceHostEffectGrants(f.space, id, keys);
    c.check("G1 the discovery grant publishes no KV subject: only INFO, both stream INFOs and both leader reads", disc.publish.length === 5
      && disc.publish.every((s) => !s.startsWith("$KV.")) && sorted(disc.subscribe) === sorted([`_INBOX_${id}.>`]), disc);
    const kvs = eff.publish.filter((s) => s.startsWith("$KV."));
    c.check("G1 the effect grant is the discovery grant plus one exact KV subject per scope key and one token under each family",
      sorted(eff.publish.filter((s) => !s.startsWith("$KV."))) === sorted(disc.publish) && sorted(eff.subscribe) === sorted(disc.subscribe)
      && kvs.length === keys.records.length + keys.auth.length + keys.authFamilies.length && keys.authFamilies.length === 1 && keys.records.length === 2, { eff, keys });
    c.check("G1 no effect subject carries `>`, and `*` only as a family's final token", eff.publish.every((s) => !s.includes(">"))
      && kvs.filter((s) => s.includes("*")).every((s) => s.endsWith(".*") && s.indexOf("*") === s.length - 1) && kvs.filter((s) => s.includes("*")).length === 1, kvs);
    const refusesKey = (k: ServiceWriteScope) => { try { serviceHostEffectGrants(f.space, id, k); return false; } catch (e) { return e instanceof EpEnvelopeError && e.code === "bad-request"; } };
    const bad = ["a.*", "a.>", "", "a..b", ".a", "a.", "a b", "a\tb", ">", "*"];
    c.check("G1 a wildcard, empty, padded or blank key is refused in either bucket", bad.every((k) => refusesKey({ records: [], auth: [k], authFamilies: [] })
      && refusesKey({ records: [k], auth: [], authFamilies: [] })), bad);
    c.check("G1 a family that does not end in exactly one dot, or carries a wildcard, is refused", ["cred.x", "cred.*.", "", ".", "cred..", "cred.>."]
      .every((k) => refusesKey({ records: [], auth: [], authFamilies: [k] })));

    const r = await relay(f.server);
    let built = 0, conns = 0;
    const opts = (over: Partial<AuthorityClientOpts>): AuthorityClientOpts => ({
      server: r.url, space: f.space, dataAccount: f.dataAccount!, log: () => {}, label: serviceHostEffectLabel(f.space),
      grants: (cid) => { built++; return serviceHostEffectGrants(f.space, cid, keys); }, noReconnect: true, onConnection: () => { conns++; },
      serviceHostInvocation: { deadlineMs: Date.now() + 5_000 }, ...over,
    });
    const now = () => Date.now();
    const cases: Array<[string, () => Partial<AuthorityClientOpts>, boolean]> = [
      ["a non-number deadline", () => ({ serviceHostInvocation: { deadlineMs: "soon" as unknown as number } }), true],
      ["a NaN deadline", () => ({ serviceHostInvocation: { deadlineMs: Number.NaN } }), true],
      ["an infinite deadline", () => ({ serviceHostInvocation: { deadlineMs: Number.POSITIVE_INFINITY } }), true],
      ["a fractional deadline", () => ({ serviceHostInvocation: { deadlineMs: now() + 5_000.5 } }), true],
      ["an unsafe deadline", () => ({ serviceHostInvocation: { deadlineMs: 2 ** 53 } }), true],
      ["a deadline equal to now", () => ({ serviceHostInvocation: { deadlineMs: now() } }), true],
      ["a past deadline", () => ({ serviceHostInvocation: { deadlineMs: now() - 1 } }), true],
      ["a deadline beyond one invocation", () => ({ serviceHostInvocation: { deadlineMs: now() + SERVICE_HOST_INVOCATION_MS + 1_000 } }), true],
      ["a deadline given in seconds", () => ({ serviceHostInvocation: { deadlineMs: Math.ceil(now() / 1000) + 30 } }), true],
      ["another profile's label", () => ({ label: `cotal:auth-mint:${f.space}` }), true],
      ["another space's effect label", () => ({ label: serviceHostEffectLabel("s2a-other") }), true],
      ["no noReconnect", () => ({ noReconnect: undefined }), true],
      ["noReconnect false", () => ({ noReconnect: false }), true],
      ["a plane candidate", () => ({ planeCandidate: true }), true],
      ["tool-result custody", () => ({ toolResultCustody: true }), false],
      ["a renewal probe", () => ({ probeRenewal: { intervalMs: 1_000 } }), true],
      ["a renewal-failure callback", () => ({ onRenewalFailure: () => {} }), true],
    ];
    const refused: string[] = [];
    for (const [label, over, precondition] of cases) {
      try { const cl = await openAuthorityClient(opts(over())); await cl.close(); }
      catch (e) { if (!precondition || (e instanceof EpEnvelopeError && e.code === "failed-precondition")) refused.push(label); }
    }
    c.check("G2 the effect profile refuses every bad deadline, label, reconnect, plane, custody or renewal option", refused.length === cases.length,
      cases.map(([l]) => l).filter((l) => !refused.includes(l)));
    c.check("G2 every refusal came before any identity, grant or connection: none built, none opened, the relay saw zero sockets",
      built === 0 && conns === 0 && r.accepted === 0, { built, conns, accepted: r.accepted });

    const dl = Date.now() + 5_000;
    const ok = await openAuthorityClient(opts({ serviceHostInvocation: { deadlineMs: dl } }));
    const claims = claimsOf(r.jwts.at(-1) ?? ""), ex = claims.exp ?? Number.NaN;
    c.check("G3 a valid effect connects once, and the presented JWT expires at ceil(deadline / 1000) whole seconds",
      r.accepted === 1 && r.jwts.length === 1 && ex === Math.ceil(dl / 1000) && Number.isSafeInteger(ex) && ex * 1000 >= dl && ex * 1000 - dl < 1000, { exp: ex, dl });
    c.check("G3 the presented JWT names the effect label and its own identity, and grants exactly the effect grant", claims.name === serviceHostEffectLabel(f.space)
      && claims.sub === ok.connId && sorted(claims.nats.pub?.allow ?? []) === sorted(serviceHostEffectGrants(f.space, ok.connId, keys).publish)
      && sorted(claims.nats.sub?.allow ?? []) === sorted([`_INBOX_${ok.connId}.>`]), { name: claims.name, pub: claims.nats.pub, sub: claims.nats.sub });
    c.check("G3 the effect exposes its gone signal", ok.gone instanceof Promise);
    const ab = `KV_${epAuthBucket(f.space)}`, rb = `KV_${recordsBucket(f.space)}`;
    const api = [`$JS.API.STREAM.CREATE.${ab}`, `$JS.API.STREAM.UPDATE.${rb}`, `$JS.API.STREAM.PURGE.${ab}`, `$JS.API.STREAM.DELETE.${rb}`,
      `$JS.API.STREAM.MSG.DELETE.${ab}`, `$JS.API.CONSUMER.CREATE.${ab}`, `$JS.API.DIRECT.GET.${rb}`, `${f.space}.anything`];
    const denials = await Promise.allSettled(api.map((subject) => ok.nc.request(subject, new Uint8Array(), { timeout: 3_000 })));
    c.check("G3 the effect credential is refused every stream or consumer management call, Direct Get and any non-KV subject",
      denials.every((x) => x.status === "rejected" && /permission/i.test(String((x.reason as Error)?.message))), denials.map((x, n) => `${api[n]}: ${x.status === "rejected" ? String((x.reason as Error)?.message).slice(0, 60) : "answered"}`));
    await ok.close();
    c.check("G3 close resolves gone", (await within(ok.gone!.then(() => true), 2_000)) === true);

    const hang = await relay(f.server, true), t0 = Date.now(), dh = t0 + 1_500;
    let hung = "";
    try { const cl = await openAuthorityClient(opts({ server: hang.url, serviceHostInvocation: { deadlineMs: dh } })); await cl.close(); hung = "connected"; }
    catch (e) { hung = (e as Error).message; }
    const waited = Date.now() - t0;
    console.log(`INFO G4 handshake to a silent broker failed after ${waited} ms (window ${dh - t0} ms)`);
    c.check("G4 a broker that never answers fails the handshake within the remaining window, not the client's 20 s default",
      hung !== "connected" && hang.accepted === 1 && waited >= 1_000 && waited <= dh - t0 + 750, { hung, waited });

    // G5: the broker grant on the real adapter. Every allowed key lands; every neighbour is refused and absent.
    const eff2 = await f.effect(keys), kv = registryStores(eff2.registry), before = f.violations.length;
    const headOf = (inst: string, owner = f.owner) => lifecycleHeadKey(owner, serviceEndpointActor({ accountPublicKey: f.accountPublicKey, space: f.space, owner, endpoint: f.endpoint, instanceId: inst }));
    const allowed: Array<["records" | "auth", string]> = [...keys.records.map((k) => ["records", k] as ["records", string]), ...keys.auth.map((k) => ["auth", k] as ["auth", string]),
      ["auth", `cred.${u}.${mintLifecycleUid()}`]];
    const u2 = mintLifecycleUid(), i2 = rid();
    const neighbours: Array<["records" | "auth", string, string]> = [
      ["auth", `svcop.${hex(32)}`, "another operation"], ["auth", `svcprop.${hex(64)}`, "another proposal"],
      ["auth", `svcasg.${f.endpoint.replaceAll(".", "_")}.${i2}`, "another selector's assignment"], ["auth", epgateKey(f.endpoint, i2), "another selector's endpoint gate"],
      ["auth", `gate.${u2}`, "another UID's gate"], ["auth", `cred.${u2}.${mintLifecycleUid()}`, "another UID's root credential"],
      ["records", uidReservationKey(u2), "another UID's reservation"], ["records", headOf(i2), "another actor's head"],
      ["records", headOf(instanceId, `u_${"d".repeat(26)}`), "another owner's head"], ["auth", "svchost.admission", "the admission key outside startup"],
      ["auth", `cred.${u}.${mintLifecycleUid()}.extra`, "two tokens under the family"], ["auth", `cred.${u}`, "the family root itself"],
    ];
    const put = (b: "records" | "auth", k: string) => (b === "records" ? kv.recordsKv : kv.authKv).put(k, bytesOf({ simulation: "effect-grant-probe", k }), { previousSeq: 0 });
    const landed = await Promise.allSettled(allowed.map(([b, k]) => put(b, k)));
    const out = await Promise.allSettled(neighbours.map(([b, k]) => put(b, k)));
    await eff2.close();
    const value = (b: "records" | "auth", k: string) => f.value(b === "records" ? f.records : f.auth, k);
    const present = await Promise.all(allowed.map(([b, k]) => value(b, k))), absent = await Promise.all(neighbours.map(([b, k]) => value(b, k)));
    const refusals = f.violations.splice(before);
    c.check("G5 (simulation writes) every scope key and one root credential id under the family land through the effect connection",
      landed.every((x) => x.status === "fulfilled") && present.every((v) => v !== null), landed.map((x, n) => `${allowed[n]![1]}: ${x.status}`));
    c.check("G5 the broker refuses every neighbour: another operation, proposal, selector, UID, actor or owner, the admission key, a deeper or bare family key",
      out.every((x) => x.status === "rejected") && absent.every((v) => v === null), neighbours.map(([, , l], n) => `${l}: ${out[n]!.status}`));
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactly = (b: "records" | "auth", k: string) => new RegExp(`${esc(`$KV.${b === "records" ? recordsBucket(f.space) : epAuthBucket(f.space)}.${k}`)}(?![-/=\\w.])`);
    c.check("G5 each refusal is the broker's own publish permission violation for exactly that subject",
      neighbours.every(([b, k]) => refusals.some((v) => /permission/i.test(v) && exactly(b, k).test(v))), { refusals: refusals.length });
  } finally { await f.close(); }
}

// ---- X: expiry at the original deadline, no reconnect, no renewal --------------------------------
{
  const f = await openFixture("s2a-effect-expiry", { limited: true });
  try {
    const r = await relay(f.server), keys = serviceHostScopeKeys({ accountPublicKey: f.accountPublicKey, space: f.space },
      { operation: "startup", operationId: null, proposalId: null, owner: null, endpoint: null, instanceId: null, lifecycleUid: null });
    const dl = Date.now() + 2_300, exp = Math.ceil(dl / 1000);
    let nc: NatsConnection | undefined;
    const statuses: string[] = [];
    const eff = await openServiceHostEffect({ server: r.url, space: f.space, dataAccount: f.dataAccount!, log: () => {}, onConnection: (n) => {
      nc = n; void (async () => { for await (const s of n.status()) statuses.push(s.type); })();
    } }, { keys, deadlineMs: dl });
    const why = nc!.closed();
    const g = await within(eff.gone.then(() => true), 6_000);
    const goneAt = Date.now(), cause = await why;
    console.log(`INFO X1 broker close observed ${goneAt - dl} ms after the deadline, ${goneAt - exp * 1000} ms after exp (${exp * 1000 - dl} ms rounding)`);
    // An ordinary-run observation on one host clock with an unpaused owned broker: timer granularity, not a close-time guarantee.
    c.check("X1 (one host clock, unpaused broker) the broker closed the effect connection after its exp second, not before the original deadline",
      g === true && goneAt >= dl && goneAt >= exp * 1000, { afterDeadlineMs: goneAt - dl, afterExpMs: goneAt - exp * 1000 });
    c.check("X1 (one host clock, unpaused broker) the close came inside the second after exp, with this suite's 500 ms scheduling allowance",
      goneAt < exp * 1000 + 1_000 + 500 && goneAt - dl <= 1_999 + 500, { afterDeadlineMs: goneAt - dl });
    c.check("X1 the close is the broker's credential expiry, not a client close", /expired/i.test(String((cause as Error | undefined)?.message ?? "")), String(cause));
    await pause(1_500);
    c.check("X2 no reconnect: no reconnect status, and the relay saw exactly one connection and one JWT", r.accepted === 1 && r.jwts.length === 1
      && !statuses.some((s) => s === "reconnect" || s === "reconnecting"), { accepted: r.accepted, statuses });
    c.check("X2 no renewal: the one JWT is the only credential ever presented, and its exp is the derived one", claimsOf(r.jwts[0]!).exp === exp);
    let closeErr = "";
    try { await eff.close(); } catch (e) { closeErr = (e as Error).message; }
    c.check("X3 closing an effect the broker already closed does not throw", closeErr === "", closeErr);
    // Broker behaviour on the version under test: a credential whose exp second has passed is refused at connect.
    const signer = fromSeed(new TextEncoder().encode(f.dataAccount!.signingSeed)), user = createUser();
    const stale = await encodeUser("stale-probe", user, fromPublic(f.dataAccount!.pub), {}, { signer, exp: Math.floor(Date.now() / 1000) - 1 });
    let refusedAt = "";
    try { const n = await connect({ servers: r.url, reconnect: false, authenticator: jwtAuthenticator(stale, user.getSeed()) }); await n.close(); refusedAt = "connected"; }
    catch (e) { refusedAt = (e as Error).message; }
    c.check("X4 the broker refuses a connect whose exp second has passed", refusedAt !== "connected" && refusedAt !== "", refusedAt);
  } finally { await f.close(); }
}

// ---- E: the engine over real effect connections ---------------------------------------------------
{
  const f = await openFixture("s2a-effect-engine", { limited: true });
  try {
    const dir = ledger(f.owner), d = await f.discovery(), r = await relay(f.server), cluster = D("cluster");
    const scopes: ServiceHostEffectScope[] = [];
    let lastGone: Promise<void> = Promise.resolve();
    const via = (url: string): Partial<ServiceHostOperationsOptions> => ({ openEffect: async (scope) => {
      scopes.push(scope);
      const eff = await f.effect(scope.keys, scope.deadlineMs, url);
      lastGone = eff.gone;
      return eff;
    } });
    const e = await engine(f, dir, d, via(r.url));
    const p = await register(f, e, cluster), a = L(await e.handle(approve(f, p))), v = L(await e.handle(revoke(f, p.instanceId, a.approval!.assignment.assignmentDigest)));
    c.check("E1 startup, register, approve and revoke complete over relayed effect connections", a.state === "approved" && v.state === "pending", { a, v });
    const claims = r.jwts.map(claimsOf);
    c.check("E1 one connection and one JWT per invocation, each a fresh identity", r.accepted === scopes.length && claims.length === scopes.length
      && new Set(claims.map((x) => x.sub)).size === scopes.length && scopes.length >= 4, { accepted: r.accepted, jwts: claims.length, invocations: scopes.length });
    c.check("E1 each JWT expires at its invocation's deadline rounded up to the second, and grants exactly that invocation's scope keys",
      scopes.every((s, n) => claims[n]!.exp === Math.ceil(s.deadlineMs / 1000) && sorted(claims[n]!.nats.pub?.allow ?? []) === sorted(serviceHostEffectGrants(f.space, claims[n]!.sub, s.keys).publish)),
      scopes.map((s, n) => ({ op: s.operation, exp: claims[n]!.exp, deadline: s.deadlineMs })));

    // An abrupt socket loss right after a write landed: the write's step reports held, nothing follows, no reconnect.
    const q = await register(f, e, cluster), x = approve(f, q), opKey = `svcop.${serviceHostOperationId(f.space, x.requestId)}`;
    const after: WriteCall[] = [];
    let cutDone = false;
    const spy = f.faults.onWrite((w) => { if (cutDone) after.push(w); return false; }, {}, Number.MAX_SAFE_INTEGER);
    const arm = f.faults.onWrite((w) => w.key === opKey && w.kind === "create", { after: async () => { r.cut(); await within(lastGone, 3_000); cutDone = true; } });
    const before = r.accepted, lost = L(await e.handle(x));
    spy.disarm();
    c.check("E2 a socket reset after the binding landed holds the approve under its operation at the write's own step", arm.hits === 1 && lost.state === "held"
      && lost.reason === "post-write-readiness" && lost.operationId === serviceHostOperationId(f.space, x.requestId), lost);
    c.check("E2 no write follows the loss, and the effect never reconnects: the approve opened exactly one connection", cutDone && after.length === 0 && r.accepted === before + 1,
      { after: after.map((w) => w.key), accepted: r.accepted, before });
    const again = L(await e.handle(x));
    c.check("E2 a replay opens a fresh effect connection and completes the approval", again.state === "approved" && r.accepted === before + 2, again);
    f.faults.clear();

    // A loss between discovery and the first write: the request ends without a write.
    // Discovery reads the same key over its own connection first; only the effect's read (after its connection opened) cuts.
    const s = await register(f, e, cluster), y = approve(f, s), writes: WriteCall[] = [], base = r.accepted;
    let cuts = 0;
    const spy2 = f.faults.onWrite((w) => { writes.push(w); return false; }, {}, Number.MAX_SAFE_INTEGER);
    const readCut = f.faults.onRead("auth", `svcop.${serviceHostOperationId(f.space, y.requestId)}`, async () => {
      if (r.accepted > base && cuts === 0) { cuts++; r.cut(); await within(lastGone, 3_000); }
    }, Number.MAX_SAFE_INTEGER);
    const early = L(await e.handle(y));
    spy2.disarm(); readCut.disarm();
    c.check("E3 a socket reset during the invocation's first read ends the approve held or denied with zero writes", cuts === 1
      && (early.state === "held" || early.state === "denied") && writes.length === 0 && (await f.value(f.auth, `svcop.${serviceHostOperationId(f.space, y.requestId)}`)) === null, { early, writes: writes.map((w) => w.key) });
    f.faults.clear();

    // An effect that cannot open: a bound replay holds under its operation, a fresh request is a zero-write denial, construction refuses.
    const dead = await relay(f.server);
    await dead.close();
    const bound = approve(f, await register(f, e, cluster)), first = L(await e.handle(bound));
    const nowDown = await openServiceHostOperations({ discovery: d.registry, hold: f.hold, accountPublicKey: f.accountPublicKey, ledgerDir: dir, startup: { kind: "normal" },
      openEffect: (scope) => scope.operation === "startup" ? f.effect(scope.keys, scope.deadlineMs) : f.effect(scope.keys, scope.deadlineMs, dead.url) });
    const replay = L(await nowDown.handle(bound)), fresh = approve(f, await register(f, e, cluster)), unbound = L(await nowDown.handle(fresh));
    c.check("E4 (setup) the approve completed before its effect address went dead", first.state === "approved", first);
    c.check("E4 a bound replay whose effect cannot connect holds unavailable at effect-open under its operation", replay.state === "held" && replay.reason === "unavailable"
      && replay.phase === "effect-open" && replay.operationId === serviceHostOperationId(f.space, bound.requestId), replay);
    c.check("E4 an unbound request whose effect cannot connect is a zero-write denial", unbound.state === "denied" && unbound.reason === "unavailable"
      && (await f.value(f.auth, `svcop.${serviceHostOperationId(f.space, fresh.requestId)}`)) === null, unbound);
    let ctor = "";
    try { await openServiceHostOperations({ discovery: d.registry, hold: f.hold, accountPublicKey: f.accountPublicKey, ledgerDir: dir, startup: { kind: "normal" },
      openEffect: (scope) => f.effect(scope.keys, scope.deadlineMs, dead.url) }); ctor = "constructed"; }
    catch (err) { ctor = (err as Error).message; }
    c.check("E4 construction whose startup effect cannot connect refuses", ctor !== "constructed" && ctor.includes("effect connection did not open"), ctor);
    await d.close();
    c.check("E (broker grants) no effect or discovery connection of this section was refused a publish", f.violations.length === 0, f.violations);
  } finally { await f.close(); }
}

for (const r of relays) await r.close();
for (const dir of ledgers) rmSync(dir, { recursive: true, force: true });
console.log(`service-host-effect: ${c.passed} passed, ${c.failed} failed (owned-broker fixture evidence only; invocation limit ${S2A_INVOCATION_MS} ms)`);
if (c.failed) process.exitCode = 1;
