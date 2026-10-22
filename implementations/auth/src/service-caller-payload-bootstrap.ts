/** Host-only payload observer and bootstrap. Uses the native broker VARZ API, never a caller's
 * supplied topology or measurements. No generic SYS credential enters the data account or a client. */
import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  EpEnvelopeError, canonicalJson, contractDigest, credsClaims, dialerFor, epAuthBucket, isAccountNkey, newIdentity, recordsBucket,
} from "@cotal-ai/core";
import { openAuthorityClient } from "./authority-client.js";
import { openLifecycleRegistry, registryMaxPayload, registryServerId, registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { readPlaneClaim, genuinePlaneHold, type PlaneClaimHold } from "./plane-claim.js";
import { parseServiceCallerPayloadRecord, SERVICE_CALLER_PAYLOAD_FLOOR, SERVICE_CALLER_PAYLOAD_KEY, type ServiceCallerPayloadRecord } from "./service-caller-payload.js";

const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: true });
/** Broker-owner provisioning only. Needs the registered SYS signing seed, not operator/root seed.
 * The resulting short-lived credential can read VARZ only and is never persisted by this helper. */
export async function mintServiceCallerPayloadObserverCreds(sys: { pub: string; signingSeed: string }): Promise<string> {
  if (!isAccountNkey(sys.pub)) throw new Error("payload observer requires the broker system account");
  const id = newIdentity(), prefix = `_INBOX_${id.id}`, user = fromSeed(enc.encode(id.seed));
  const jwt = await encodeUser("service-caller-payload-observer", fromPublic(id.id), fromPublic(sys.pub),
    { pub: { allow: ["$SYS.REQ.SERVER.*.VARZ"] }, sub: { allow: [`${prefix}.>`] } },
    { signer: fromSeed(enc.encode(sys.signingSeed)), exp: Math.floor(Date.now() / 1000) + 60 });
  return dec.decode(fmtCreds(jwt, user));
}
export interface ServiceCallerPayloadBootstrap {
  /** Host-private fresh short-lived VARZ-only credential, issued by the broker owner. */
  observerCreds(): string | Promise<string>;
}
const fail = (detail: string): never => { throw new EpEnvelopeError("failed-precondition", `service caller payload: ${detail}`); };
async function beforeDeadline<T>(deadline: number, work: () => Promise<T>, late?: (result: T) => Promise<void>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
  const ms = deadline - Date.now();
  if (ms <= 0) fail("observation deadline expired");
  const flight = Promise.resolve().then(work).then(async value => {
    if (expired) { await late?.(value); fail("observation deadline expired"); }
    return value;
  });
  try {
    return await Promise.race([flight, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new EpEnvelopeError("failed-precondition", "service caller payload: observation deadline expired")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
const emptyObject = (o: unknown): boolean => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 0;

/** A real complete single-server observation. Cluster/gateway/leaf configurations refuse even
 * when no peer is connected: reply counts and current route counts cannot prove topology. */
async function observe(registry: LifecycleRegistry, servers: string, source: ServiceCallerPayloadBootstrap, deadline: number,
  onConnection?: (nc: NatsConnection, label: string) => void) {
  const serverId = registryServerId(registry), creds = await beforeDeadline(deadline, async () => source.observerCreds()), claims = credsClaims(creds);
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) fail("observation deadline expired"); return ms; };
  if (!serverId || !/^N[A-Z2-7]{55}$/.test(serverId)) fail("the data connection has no broker incarnation");
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || !Number.isSafeInteger(claims.exp) || !claims.exp || claims.exp <= now || claims.exp > now + 60)
    fail("observer credential must expire within sixty seconds");
  const allow = claims.nats?.pub?.allow, sub = claims.nats?.sub?.allow;
  if (canonicalJson(allow) !== canonicalJson(["$SYS.REQ.SERVER.*.VARZ"]) || canonicalJson(sub) !== canonicalJson([`_INBOX_${claims.sub}.>`]))
    fail("observer must have exactly VARZ-only read authority");
  let nc: NatsConnection | undefined;
  try {
    nc = await beforeDeadline(deadline, () => dialerFor(servers)({ servers, authenticator: credsAuthenticator(enc.encode(creds)), inboxPrefix: `_INBOX_${claims.sub}`,
      reconnect: false, timeout: Math.min(3000, remaining()), name: "cotal:service-caller-payload-observer" }), late => late.close());
    onConnection?.(nc, "cotal:service-caller-payload-observer");
    if (nc.info?.server_id !== serverId) fail("observer and data connection reached different brokers");
    const reply = await nc.request(`$SYS.REQ.SERVER.${serverId}.VARZ`, enc.encode("{}"), { timeout: Math.min(3000, remaining()) });
    const raw = JSON.parse(dec.decode(reply.data));
    const data = raw?.data;
    if (raw?.error !== undefined || raw?.server?.id !== serverId || data?.server_id !== serverId) fail("VARZ response does not bind this broker");
    if (Object.hasOwn(raw.server, "cluster") || !emptyObject(data.cluster) || !emptyObject(data.gateway) || !emptyObject(data.leaf)
      || data.routes !== 0 || data.remotes !== 0 || data.leafnodes !== 0) fail("only a declared standalone broker without gateway or leaf links is supported");
    if (!Number.isSafeInteger(data.max_payload) || data.max_payload < SERVICE_CALLER_PAYLOAD_FLOOR)
      fail(`broker max_payload ${String(data.max_payload)} is below required ${SERVICE_CALLER_PAYLOAD_FLOOR} bytes (2 MiB plus 1 KiB); configure the broker explicitly before enabling caller policy`);
    if (!Number.isSafeInteger(data.max_control_line) || data.max_control_line < 4096) fail("broker max_control_line does not admit native policy writes");
    if (typeof data.config_digest !== "string" || !data.config_digest || typeof data.start !== "string" || typeof data.system_account !== "string"
      || data.system_account !== (claims.nats?.issuer_account ?? claims.iss)) fail("VARZ config/system-account evidence is missing or foreign");
    const stores = registryStores(registry), stream = await beforeDeadline(deadline, () => stores.jsm.streams.info(`KV_${epAuthBucket(stores.space)}`));
    if (stream.config.max_msg_size !== -1) fail("auth stream must have no per-message size cap");
    const maxPayload = registryMaxPayload(registry);
    if (registryServerId(registry) !== serverId || maxPayload === undefined || maxPayload < SERVICE_CALLER_PAYLOAD_FLOOR) fail("data connection moved or has insufficient payload");
    remaining();
    return { serverId: serverId!, configDigest: data.config_digest as string, floor: data.max_payload as number,
      evidenceDigest: contractDigest({ serverId, systemAccount: data.system_account, start: data.start, configDigest: data.config_digest,
        maxPayload: data.max_payload, maxControlLine: data.max_control_line, cluster: data.cluster, gateway: data.gateway, leaf: data.leaf,
        stream: { name: stream.config.name, created: stream.created, maxMsgSize: stream.config.max_msg_size } }) };
  } finally { await nc?.close(); }
}

/** Startup assertion, and a fresh live verifier for each later positive issuance. The writer
 * holds only this exact metadata key. The auth plane's existing claim must still be held. */
export async function bootstrapServiceCallerPayload(opts: {
  registry: LifecycleRegistry; hold: PlaneClaimHold; servers: string; accountPublicKey: string;
  dataAccount: { pub: string; signingSeed: string }; source: ServiceCallerPayloadBootstrap;
  onConnection?: (nc: NatsConnection, label: string) => void;
}): Promise<() => Promise<void>> {
  const { registry, hold, source, servers, accountPublicKey, dataAccount } = opts, space = registryStores(registry).space;
  if (dataAccount.pub !== accountPublicKey) fail("assertion account differs from the host assignment");
  const proof = genuinePlaneHold(hold);
  if (!proof || proof.space !== space) fail("assertion requires this account's genuine plane claim");
  const assertHeld = (_what: string, deadline: number) => beforeDeadline(deadline, () => proof!.assertHeld("before"));
  const deadline = Date.now() + 10_000;
  await assertHeld("assert caller payload", deadline);
  const evidence = await observe(registry, servers, source, deadline, opts.onConnection);
  const broker = { serverId: evidence.serverId, configDigest: evidence.configDigest, claimId: hold.claimId, claimGeneration: hold.generation };
  const row: Extract<ServiceCallerPayloadRecord, { state: "asserted" }> = { v: 1, kind: "service-caller-payload", state: "asserted", floor: evidence.floor,
    assertedAtMs: Date.now(), evidenceDigest: evidence.evidenceDigest, broker };
  const writer = await beforeDeadline(deadline, () => openAuthorityClient({ onConnection: opts.onConnection, server: servers, space, dataAccount, label: "cotal:service-caller-payload-bootstrap", noReconnect: true,
    grants: id => ({ publish: ["$JS.API.INFO", `$JS.API.STREAM.INFO.KV_${epAuthBucket(space)}`, `$JS.API.STREAM.INFO.KV_${recordsBucket(space)}`,
      `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`, `$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`, `$KV.${epAuthBucket(space)}.${SERVICE_CALLER_PAYLOAD_KEY}`], subscribe: [`_INBOX_${id}.>`] }), log: () => {} }), late => late.close());
  const writerDeadline = setTimeout(() => { void writer.close(); }, Math.max(0, deadline - Date.now()));
  let assertedRevision: number;
  try {
    const r = await beforeDeadline(deadline, () => openLifecycleRegistry(writer.nc, space));
    if (registryServerId(r) !== evidence.serverId) fail("assertion writer reached another broker");
    const kv = registryStores(r).authKv, previous = await beforeDeadline(deadline, () => kv.get(SERVICE_CALLER_PAYLOAD_KEY));
    if (previous && previous.operation !== "PUT") fail("assertion key has deletion history");
    if (previous) parseServiceCallerPayloadRecord(JSON.parse(dec.decode(previous.value)));
    await assertHeld("commit caller payload assertion", deadline);
    const bytes = enc.encode(canonicalJson(row));
    const revision = previous ? await kv.update(SERVICE_CALLER_PAYLOAD_KEY, bytes, previous.revision) : await kv.create(SERVICE_CALLER_PAYLOAD_KEY, bytes);
    const after = await beforeDeadline(deadline, () => kv.get(SERVICE_CALLER_PAYLOAD_KEY));
    if (!after || after.operation !== "PUT" || after.revision !== revision || dec.decode(after.value) !== dec.decode(bytes)) fail("assertion write outcome is unconfirmed");
    assertedRevision = revision;
    await assertHeld("release caller payload assertion", deadline);
  } finally { clearTimeout(writerDeadline); await writer.close(); }
  return async () => {
    const deadline = Date.now() + 10_000;
    await assertHeld("verify caller payload", deadline);
    const fresh = await observe(registry, servers, source, deadline, opts.onConnection);
    if (fresh.serverId !== broker.serverId || fresh.configDigest !== broker.configDigest || fresh.evidenceDigest !== row.evidenceDigest)
      fail("broker configuration changed since bootstrap; reopen and reassert before caller issuance");
    const assertion = await beforeDeadline(deadline, () => registryStores(registry).authKv.get(SERVICE_CALLER_PAYLOAD_KEY));
    if (!assertion || assertion.operation !== "PUT" || assertion.revision !== assertedRevision || dec.decode(assertion.value) !== canonicalJson(row))
      fail("payload assertion changed or was withdrawn since bootstrap");
    await beforeDeadline(deadline, () => proof!.assertHeld("after"));
    const claim = await beforeDeadline(deadline, () => readPlaneClaim(registryStores(registry).authKv, space));
    if (!claim || claim.state !== "held" || claim.claimId !== broker.claimId || claim.generation !== broker.claimGeneration)
      fail("payload assertion belongs to another plane claim");
  };
}
