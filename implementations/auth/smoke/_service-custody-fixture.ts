/** Owned-broker fixture for the dormant service custody writer suites. The broker, registry,
 * plane-claim hold, account and service name are fixture-supplied original material; nothing here
 * exercises S2 durable host authentication or any production account, grant or serving path.
 *
 * Fault injection wraps only the registry's own records and auth KV handles (the ones the writer
 * issues its creates and CASes through) and its manager's stream reads. Writer and helper source
 * stay unchanged. Every injected fault is one of: a lost ACK (the write lands, the caller gets an
 * ambiguous error), a write never sent (ambiguous error), a write held past the request timeout, a
 * deferred original write the fixture issues later, or fixture work run before or after a write.
 *
 * A `limited` fixture runs the broker in operator mode instead. Its own connection is unrestricted.
 * `effect` opens the product's per-invocation effect connection (its credential publishes exactly
 * the given write keys and expires at the given original deadline) and `discovery` a connection on
 * the product's discovery grant (no write at all), so a write outside them is refused by the broker
 * itself. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, jwtAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { encodeAccount, encodeOperator, encodeUser } from "@nats-io/jwt";
import { jetstreamManager } from "@nats-io/jetstream";
import { KvWatchInclude, Kvm, type KV } from "@nats-io/kv";
import { createAccount, createOperator, createUser } from "@nats-io/nkeys";
import {
  contractDigest, createEndpointStreams, epAuthBucket, epgateKey, isReachable, lifecycleHeadKey, mintLifecycleUid,
  recordsBucket, serviceEndpointActor, uidReservationKey, type ServiceUidCustodyV1,
} from "@cotal-ai/core";
import { openLifecycleRegistry, registryStores, type LifecycleRegistry } from "../src/lifecycle-registry.js";
import { acquirePlaneClaim, PLANE_CLAIM_KEY, type PlaneClaimHold, type PlaneLivenessOracle } from "../src/plane-claim.js";
import { bindNativeServiceName } from "../src/native-service-name.js";
import {
  cancelServiceCustody, openServiceCustodyHost, runServiceBootstrap, sealServiceBootstrapIntent, sealServiceCancelIntent,
  type ServiceBootstrapResult, type ServiceCancelResult,
} from "../src/service-custody.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { ServiceWriteScope } from "../src/service-write.js";
import { serviceHostDiscoveryGrants } from "../src/authority-client.js";
import { S2A_INVOCATION_MS, openServiceHostEffect, type ServiceHostEffect } from "../src/service-host-ops.js";

const enc = new TextEncoder(), dec = new TextDecoder();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A bounded fixture wait; resolves `undefined` when the event never comes. */
export const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, pause(ms).then(() => undefined)]);
/** An outcome the writer cannot classify from the error alone. Never a CAS loss. */
export const ambiguous = () => new Error("fixture: ambiguous outcome");

export interface Checks {
  passed: number; failed: number; check(label: string, ok: boolean, detail?: unknown): void;
  /** Prints the canonical sentinel the CI shard grades, as the suite's last line. The suite keeps its own banner and exit status. */
  finish(): void;
}
export function checks(): Checks {
  const c: Checks = {
    passed: 0, failed: 0,
    check(label, ok, detail) {
      if (ok) { c.passed++; console.log(`PASS ${label}`); }
      else { c.failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail)); }
    },
    finish() { emitSentinel({ passed: c.passed, failed: c.failed }); },
  };
  return c;
}

/** One write the writer is about to issue through the registry's own KV handle. */
export interface WriteCall { bucket: "records" | "auth"; key: string; bytes: Uint8Array; kind: "create" | "cas"; revision?: number; value: Record<string, unknown> | undefined }
export interface WritePlan {
  /** Fixture work before the write is issued. */
  before?: (call: WriteCall) => Promise<void>;
  /** Fixture work after the write landed, before its result returns to the writer. */
  after?: (call: WriteCall) => Promise<void>;
  fault?: "ack-lost" | "not-sent" | "held" | "deferred";
  /** For `deferred`: receives the original write, which the fixture may issue later. */
  deferred?: (issue: () => Promise<unknown>) => void;
}
interface WriteArm { match: (c: WriteCall) => boolean; plan: WritePlan; times: number; hits: number }
interface ReadArm { match: (subject: string) => boolean; after: (subject: string) => Promise<void>; times: number; hits: number }

/** Operator-mode material: one data account with JetStream, whose signing key signs every user as
 *  the auth service signs its own. A user without `perms` is unrestricted. */
async function operatorStack(dir: string, port: number) {
  const op = createOperator(), sys = createAccount(), account = createAccount(), signer = createAccount();
  const limits = { subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1, data: -1, payload: -1, wildcards: true,
    mem_storage: -1, disk_storage: -1, streams: -1, consumer: -1 };
  const sysJwt = await encodeAccount("SYS", sys, {}, { signer: op });
  const accountJwt = await encodeAccount("fixture-data", account, { limits, signing_keys: [signer.getPublicKey()] }, { signer: op });
  const config = join(dir, "server.conf");
  writeFileSync(config, [`port: ${port}`, "host: 127.0.0.1",
    `operator: ${await encodeOperator("fixture-operator", op, { system_account: sys.getPublicKey() })}`, `system_account: ${sys.getPublicKey()}`,
    "resolver: MEMORY", `resolver_preload: { ${sys.getPublicKey()}: ${sysJwt}, ${account.getPublicKey()}: ${accountJwt} }`,
    `jetstream: { store_dir: ${JSON.stringify(join(dir, "js"))} }`, ""].join("\n"));
  const user = async (name: string, perms?: (id: string) => { pub: string[]; sub: string[] }) => {
    const u = createUser(), id = u.getPublicKey(), p = perms?.(id);
    const jwt = await encodeUser(name, u, account, p ? { pub: { allow: p.pub }, sub: { allow: p.sub } } : {}, { signer });
    return { id, authenticator: jwtAuthenticator(jwt, u.getSeed()) };
  };
  // The data account's signing key, as the auth service holds it to mint its own connections.
  const dataAccount = { pub: account.getPublicKey(), signingSeed: dec.decode(signer.getSeed()) };
  return { config, accountPublicKey: account.getPublicKey(), dataAccount, user };
}

export async function openFixture(space: string, opts: { endpoint?: string; owner?: string; limited?: boolean } = {}) {
  const endpoint = opts.endpoint ?? "org.example.recovery";
  const owner = opts.owner ?? `u_${"c".repeat(26)}`;
  const port = await pickFreePort();
  if (port === 4222) throw new Error("fixture refuses the default NATS port");
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const stack = opts.limited ? await operatorStack(dir, port) : undefined;
  const server = `nats://127.0.0.1:${port}`;
  const broker = spawn("nats-server", stack ? ["-c", stack.config] : ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
  const releaseBroker = teardownOnSignal(broker, dir);
  let nc: NatsConnection | undefined;
  const limitedConns = new Set<NatsConnection>();
  const close = async () => {
    for (const lc of limitedConns) await lc.close().catch(() => {});
    await nc?.close().catch(() => {});
    broker.kill("SIGTERM");
    await new Promise<void>((r) => { if (broker.exitCode !== null || broker.signalCode !== null) r(); else broker.once("exit", () => r()); });
    releaseBroker();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (let n = 0; !(await isReachable(`nats://127.0.0.1:${port}`)); n++) {
      if (n >= 50) throw new Error("owned fixture broker failed readiness");
      await pause(100);
    }
    nc = await connect({ servers: `nats://127.0.0.1:${port}`, reconnect: false, name: `s1-${space}`,
      ...(stack ? { authenticator: (await stack.user("fixture-main")).authenticator } : {}) });
  } catch (e) { await close(); throw e; }
  const conn = nc;
  await createEndpointStreams(await jetstreamManager(conn), new Kvm(conn), space);
  const reg: LifecycleRegistry = await openLifecycleRegistry(conn, space);
  // Raw fixture handles: separate from the registry's, so fixture writes are never intercepted.
  const records = await new Kvm(conn).open(recordsBucket(space));
  const auth = await new Kvm(conn).open(epAuthBucket(space));
  const neverOracle: PlaneLivenessOracle = async () => { throw new Error("the oracle must not be consulted on a create path"); };
  const tuple = (n: number) => ({ serverId: `NRECOVERY${n}`, cid: n, userNkey: `U${String.fromCharCode(64 + n).repeat(55)}` });
  const hold: PlaneClaimHold = await acquirePlaneClaim({ nc: conn, space, ledger: tuple(1), records: tuple(2), oracle: neverOracle, log: () => {} });
  const accountPublicKey = stack?.accountPublicKey ?? createAccount().getPublicKey();
  const name = await bindNativeServiceName(reg, { accountPublicKey, space }, {
    v: 1, kind: "service-endpoint-host", requestId: "c".repeat(32), operation: "name-bind",
    granter: { kind: "operator", auditId: "fixture-verified-claim" },
    input: { endpoint, owner, expectedRevision: 0, claimReference: "fixture-namespace-claim" },
  });

  const reservation = (over: { endpoint?: string; instanceId?: string } = {}): ServiceUidCustodyV1 => {
    const ep = over.endpoint ?? endpoint, instanceId = over.instanceId ?? mintLifecycleUid(), lifecycleUid = mintLifecycleUid();
    return {
      v: 1, kind: "native-service-uid", native: { accountPublicKey, space, lifecycleUid },
      assignment: { owner, actor: serviceEndpointActor({ accountPublicKey, space, owner, endpoint: ep, instanceId }), endpoint: ep, instanceId, duty: "serve" },
      creation: { operationId: mintLifecycleUid(), requestDigest: contractDigest({ fixture: "recovery", lifecycleUid }) },
    };
  };
  const binding = (r: ServiceUidCustodyV1) => ({ accountPublicKey, space, owner, endpoint: r.assignment.endpoint,
    instanceId: r.assignment.instanceId, lifecycleUid: r.native.lifecycleUid, assignmentDigest: contractDigest(r) });
  const keys = (r: ServiceUidCustodyV1) => ({
    uid: uidReservationKey(r.native.lifecycleUid), head: lifecycleHeadKey(owner, r.assignment.actor), gate: `gate.${r.native.lifecycleUid}`,
    epgate: epgateKey(r.assignment.endpoint, r.assignment.instanceId), root: (id: string) => `cred.${r.native.lifecycleUid}.${id}`,
  });
  const value = async (kv: KV, key: string) => { const e = await kv.get(key); return e && e.operation === "PUT" ? JSON.parse(dec.decode(e.value)) as Record<string, unknown> : null; };
  const revision = async (kv: KV, key: string) => (await kv.get(key))?.revision ?? 0;
  const freshHost = () => openServiceCustodyHost({ registry: reg, hold, accountPublicKey });
  const later = () => Date.now() + 120_000;
  // One fixture-supplied original bootstrap deadline per reservation, reused by every reseal.
  const originals = new Map<string, number>();
  const original = (r: ServiceUidCustodyV1, ms = 600_000) => {
    let d = originals.get(r.native.lifecycleUid);
    if (d === undefined) originals.set(r.native.lifecycleUid, d = Date.now() + ms);
    return d;
  };
  const cancelOp = () => ({ opId: mintLifecycleUid(), requestDigest: contractDigest({ cancel: mintLifecycleUid() }) });
  const bootstrap = (r: ServiceUidCustodyV1, host = freshHost().host): Promise<ServiceBootstrapResult> =>
    runServiceBootstrap(sealServiceBootstrapIntent(host, { reservation: r, notAfterMs: original(r) }));
  const cancel = (r: ServiceUidCustodyV1, op: { opId: string; requestDigest: string }, deadlineMs = later(), host = freshHost().host): Promise<ServiceCancelResult> =>
    cancelServiceCustody(sealServiceCancelIntent(host, { reservation: r, ...op }), { deadlineMs });
  /** Bootstrap whose host latch trips when the broker delivers the nth write to `key`. */
  const pausedBootstrap = async (r: ServiceUidCustodyV1, bucket: "records" | "auth", key: string, nth: number) => {
    const first = freshHost();
    const sub = tripOnWrite(bucket, key, nth, first.trip);
    const out = await bootstrap(r, first.host);
    sub.unsubscribe();
    return out;
  };
  const pausedCancel = async (r: ServiceUidCustodyV1, op: { opId: string; requestDigest: string }, bucket: "records" | "auth", key: string, nth: number) => {
    const first = freshHost();
    const sub = tripOnWrite(bucket, key, nth, first.trip);
    const out = await cancel(r, op, later(), first.host);
    sub.unsubscribe();
    return out;
  };
  const bucketName = (b: "records" | "auth") => (b === "records" ? recordsBucket(space) : epAuthBucket(space));
  const tripOnWrite = (bucket: "records" | "auth", key: string, nth: number, trip: (reason: string) => void) => {
    let seen = 0;
    const sub = conn.subscribe(`$KV.${bucketName(bucket)}.${key}`, { callback: () => { if (++seen === nth) { trip(`fixture pause at write ${nth} of ${key}`); sub.unsubscribe(); } } });
    return sub;
  };
  /** Every value the stream STORED for `key` (or a `*` pattern) while watching, in order. An
   *  updates-only KV watcher is an ordered stream consumer, so a publish the stream rejected (a
   *  lost create or CAS) never appears; a core subscription would count it. `stop()` waits until
   *  the watcher has caught up with the key's current revision. */
  const watch = async (bucket: "records" | "auth", key: string) => {
    const kv = bucket === "records" ? records : auth;
    const seen: (Record<string, unknown> | null)[] = [];
    let last = 0;
    const iter = await kv.watch({ key, include: KvWatchInclude.UpdatesOnly });
    void (async () => {
      for await (const e of iter) {
        last = Math.max(last, e.revision);
        if (e.operation !== "PUT") { seen.push(null); continue; }
        try { seen.push(JSON.parse(dec.decode(e.value)) as Record<string, unknown>); } catch { seen.push(null); }
      }
    })();
    return { seen, stop: async () => {
      const names: string[] = [];
      if (key.includes("*")) { for await (const k of await kv.keys(key)) names.push(k); } else names.push(key);
      let target = 0;
      for (const k of names) target = Math.max(target, (await kv.get(k))?.revision ?? 0);
      for (let n = 0; last < target && n < 100; n++) await pause(20);
      iter.stop();
      if (last < target) throw new Error(`fixture watcher of ${key} did not catch up (${last} < ${target})`);
    } };
  };
  const movePlane = async () => {
    const plane = (await auth.get(PLANE_CLAIM_KEY))!;
    const moved = await auth.update(PLANE_CLAIM_KEY, enc.encode(JSON.stringify({ ...JSON.parse(dec.decode(plane.value)), claimId: "NFOREIGNCLAIM" })), plane.revision);
    return async () => { await auth.update(PLANE_CLAIM_KEY, plane.value, moved); };
  };
  /** Rewrite `key` with its own current bytes: a sibling's no-op that moves the revision. */
  const touch = async (kv: KV, key: string) => { const e = (await kv.get(key))!; await kv.update(key, e.value, e.revision); };

  // ---- fault injection on the registries' own handles ----
  const writeArms: WriteArm[] = [];
  const readArms: ReadArm[] = [];
  /** A deferred write still in flight keeps its connection: a limited effect closes after it lands. */
  type InFlight = { add(): void; done(): void };
  const intercept = async (call: WriteCall, issue: () => Promise<number>, inFlight?: InFlight): Promise<number> => {
    const arm = writeArms.find((a) => a.hits < a.times && a.match(call));
    if (!arm) return issue();
    arm.hits++;
    const { plan } = arm;
    if (plan.before) await plan.before(call);
    switch (plan.fault) {
      case undefined: { const r = await issue(); if (plan.after) await plan.after(call); return r; }
      case "ack-lost": { await issue(); if (plan.after) await plan.after(call); throw ambiguous(); }
      case "not-sent": throw ambiguous();
      case "held": return new Promise<number>(() => {});
      case "deferred": inFlight?.add(); plan.deferred?.(inFlight ? () => issue().finally(() => inFlight.done()) : issue); throw ambiguous();
    }
  };
  /** Wrap one registry's KV puts and its manager's stream reads; every arm applies to all of them. */
  const instrument = (r: LifecycleRegistry, inFlight?: InFlight) => {
    const stores = registryStores(r);
    // `kv.update` delegates to `kv.put` with `previousSeq`, so wrapping `put` alone sees every
    // create and CAS exactly once.
    for (const bucket of ["records", "auth"] as const) {
      const kv = bucket === "records" ? stores.recordsKv : stores.authKv;
      const realPut = kv.put.bind(kv);
      const parse = (bytes: Uint8Array) => { try { return JSON.parse(dec.decode(bytes)) as Record<string, unknown>; } catch { return undefined; } };
      kv.put = ((key: string, data: Uint8Array, o?: { previousSeq?: number }) =>
        intercept({ bucket, key, bytes: data, kind: o?.previousSeq === 0 ? "create" : "cas", revision: o?.previousSeq, value: parse(data) }, () => realPut(key, data, o), inFlight)) as typeof kv.put;
    }
    const streams = stores.jsm.streams;
    const realGetMessage = streams.getMessage.bind(streams);
    streams.getMessage = (async (...args: Parameters<typeof realGetMessage>) => {
      const subject = (args[1] as { last_by_subj?: string } | undefined)?.last_by_subj ?? "";
      let result: Awaited<ReturnType<typeof realGetMessage>> | undefined, error: unknown, failed = false;
      try { result = await realGetMessage(...args); } catch (e) { error = e; failed = true; }
      const arm = readArms.find((a) => a.hits < a.times && a.match(subject));
      if (arm) { arm.hits++; await arm.after(subject); }
      if (failed) throw error;
      return result!;
    }) as typeof streams.getMessage;
  };
  instrument(reg);

  /** Limited fixtures only. Every broker permission refusal on an effect or discovery connection
   *  is recorded in `violations`. */
  const violations: string[] = [];
  const refusals = (label: string, lc: NatsConnection) => {
    limitedConns.add(lc);
    void (async () => {
      for await (const st of lc.status()) if (st.type === "error" && /permission/i.test(String((st as { error?: unknown }).error))) violations.push(`${label}: ${String((st as { error?: unknown }).error)}`);
    })();
  };
  const limitedStack = () => { if (!stack) throw new Error("this fixture's broker grants nothing per connection; open it limited"); return stack; };
  /** One invocation's product effect connection for `writes`, expiring at `deadlineMs`, with its
   *  registry instrumented; `via` reaches the broker through another address (a test relay). A
   *  deferred write still in flight keeps it open until the write lands. */
  const effect = async (writes: ServiceWriteScope, deadlineMs = Date.now() + S2A_INVOCATION_MS, via = server): Promise<ServiceHostEffect> => {
    let lc: NatsConnection | undefined;
    const real = await openServiceHostEffect({ server: via, space, dataAccount: limitedStack().dataAccount, log: () => {},
      onConnection: (nc) => { lc = nc; refusals("fixture-effect", nc); } }, { keys: writes, deadlineMs });
    let pending = 0, closing = false;
    const shut = async () => { if (lc) limitedConns.delete(lc); await real.close(); };
    instrument(real.registry, { add: () => { pending++; }, done: () => { if (--pending === 0 && closing) void shut(); } });
    return { registry: real.registry, gone: real.gone, close: async () => { if (pending > 0) closing = true; else await shut(); } };
  };
  /** A standing connection on the product discovery grant: the registry reads and no write. */
  const discovery = async (): Promise<{ registry: LifecycleRegistry; close(): Promise<void> }> => {
    const u = await limitedStack().user("fixture-discovery", (id) => { const g = serviceHostDiscoveryGrants(space, id); return { pub: g.publish, sub: g.subscribe }; });
    const lc = await connect({ servers: server, reconnect: false, name: "fixture-discovery", inboxPrefix: `_INBOX_${u.id}`, authenticator: u.authenticator });
    refusals("fixture-discovery", lc);
    const shut = async () => { limitedConns.delete(lc); await lc.close().catch(() => {}); };
    try {
      const registry = await openLifecycleRegistry(lc, space);
      instrument(registry);
      return { registry, close: shut };
    } catch (e) { await shut(); throw e; }
  };
  const faults = {
    onWrite(match: (c: WriteCall) => boolean, plan: WritePlan, times = 1) {
      const arm: WriteArm = { match, plan, times, hits: 0 };
      writeArms.push(arm);
      return { get hits() { return arm.hits; }, disarm: () => { arm.times = arm.hits; } };
    },
    /** Run `after` once the real leader read of `key` returned, before the writer sees its result. */
    onRead(bucket: "records" | "auth", key: string, after: () => Promise<void>, times = 1) {
      const subject = `$KV.${bucketName(bucket)}.${key}`;
      const arm: ReadArm = { match: (s) => s === subject, after, times, hits: 0 };
      readArms.push(arm);
      return { get hits() { return arm.hits; }, disarm: () => { arm.times = arm.hits; } };
    },
    clear() { writeArms.length = 0; readArms.length = 0; },
  };

  return {
    conn, reg, records, auth, hold, accountPublicKey, space, endpoint, owner, name, limited: stack !== undefined, effect, discovery, violations, server,
    dataAccount: stack?.dataAccount, user: stack?.user,
    reservation, binding, keys, value, revision, freshHost, later, original, cancelOp, bootstrap, cancel,
    pausedBootstrap, pausedCancel, tripOnWrite, watch, movePlane, touch, faults, close,
  };
}
export type Fixture = Awaited<ReturnType<typeof openFixture>>;
export const bytesOf = (v: unknown) => enc.encode(JSON.stringify(v));
