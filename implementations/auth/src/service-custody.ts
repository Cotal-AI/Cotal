/** Package-internal DORMANT writer for canonical R9 service native custody: bootstrap from an
 * exact reservation to an active stamped root, and endpoint-first cancellation. Nothing in the
 * product calls it and the index does not export it. It grants no approval, serving, terminal
 * retirement, alias release or rotation.
 *
 * Readiness here is local control: a genuine plane-claim hold re-read before and after every
 * write, plus a synchronous fatal latch. It is not broker writer exclusion. A paused writer can
 * still land a write after its last check; safety comes from per-key zero-history create and
 * revision CAS, which make every late write either a loss or unreleased residue. */
import type { JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  EpEnvelopeError, assertLifecycleToken, canonicalJson, epAuthBucket, isAccountNkey, isCasLoss, isContractDigest,
  lifecycleHeadKey, mintLifecycleUid, parseNativeUidCustody, recordsBucket, uidReservationKey, type ServiceUidCustodyV1,
} from "@cotal-ai/core";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { serviceGateRows, type ServiceAssignmentBinding, type ServiceGateRows } from "./native-service-gate.js";
import { readNativeServiceName } from "./native-service-name.js";
import { genuinePlaneHold, type PlaneClaimHold, type ScanGuard } from "./plane-claim.js";
import { ROOT_CREDENTIAL_TTL_MS } from "./root-credential.js";
import {
  encodeRoundTrip, parseServiceHead, parseServiceNativeGate, parseServiceNativeRoot, serviceCustodyIdentity,
  type CancelOp, type RootPlan, type ServiceCustodyIdentity, type ServiceHead, type ServiceNativeGate, type ServiceNativeRoot,
} from "./service-custody-shapes.js";
import { readRegistryServiceRoot } from "./service-root-reader.js";

/** One broker request, clipped to the remaining original deadline. */
export const S1_REQUEST_TIMEOUT_MS = 5_000;
/** Re-reads after a CAS loss before a step holds. */
export const S1_MAX_CAS_REDECIDE = 4;
/** Re-pins of a byte-identical open native gate after a sibling's touch. */
export const S1_MAX_GATE_REPIN = 8;
/** Classify-then-retry rounds for a write whose outcome is unknown. */
export const S1_MAX_UNKNOWN_ROUNDS = 3;

export interface ServiceCustodyHost { readonly space: string; readonly accountPublicKey: string }
export interface ServiceBootstrapIntent { readonly lifecycleUid: string; readonly notAfterMs: number }
export interface ServiceCancelIntent { readonly lifecycleUid: string; readonly opId: string }
export type ServiceCustodyHeld = { kind: "held"; reason: string; step: string; detail: string; opId: string };
export type ServiceBootstrapResult =
  | { kind: "active"; root: { credentialId: string; expMs: number } }
  | { kind: "cancelled"; opId: string }
  | { kind: "endpoint-revoked" } | { kind: "uid-burned" } | { kind: "identity-collision" } | { kind: "name-unbound" }
  | ServiceCustodyHeld;
export type ServiceCancelResult =
  | { kind: "pending"; phase: "cancelled-nonterminal"; root: "none" | "revoked" | "retained-stamped";
      rootDetail?: "created-revoked" | "cas-revoked" | "already-revoked"; opId: string }
  | { kind: "uid-unconfirmed"; held: true; opId: string }
  | { kind: "uid-foreign" }
  | { kind: "foreign-operation"; opId: string }
  | ServiceCustodyHeld;

interface HostInternals { registry: LifecycleRegistry; assertHeld: ScanGuard["assertHeld"]; space: string; accountPublicKey: string; tripped?: string }
interface Material { host: HostInternals; id: ServiceCustodyIdentity; binding: ServiceAssignmentBinding; epgate: ServiceGateRows; uidBytes: Uint8Array }
interface BootstrapSnapshot extends Material { notAfterMs: number }
interface CancelSnapshot extends Material { op: CancelOp }
const HOSTS = new WeakMap<ServiceCustodyHost, HostInternals>();
const BOOTSTRAPS = new WeakMap<ServiceBootstrapIntent, BootstrapSnapshot>();
const CANCELS = new WeakMap<ServiceCancelIntent, CancelSnapshot>();
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function denied(detail: string): never {
  throw new EpEnvelopeError("permission-denied", `service custody ${detail}`);
}

/** The one trusted composition: a genuine registry, a genuine hold for the same space, the
 *  configured account, and a fatal latch only the returned `trip` sets. The held check is the
 *  closure captured when the hold was acquired, never the hold's mutable `guard` field. */
export function openServiceCustodyHost(opts: { registry: LifecycleRegistry; hold: PlaneClaimHold; accountPublicKey: string }): { host: ServiceCustodyHost; trip(reason: string): void } {
  const { space } = registryStores(opts.registry);
  const genuine = genuinePlaneHold(opts.hold);
  if (genuine === undefined) return denied("requires a plane claim hold this process acquired");
  if (genuine.space !== space) denied(`hold belongs to another space than the registry's "${space}"`);
  if (typeof opts.accountPublicKey !== "string" || !isAccountNkey(opts.accountPublicKey)) denied("requires the configured account public key");
  const internals: HostInternals = { registry: opts.registry, assertHeld: genuine.assertHeld, space, accountPublicKey: opts.accountPublicKey };
  const host: ServiceCustodyHost = Object.freeze({ space, accountPublicKey: opts.accountPublicKey });
  HOSTS.set(host, internals);
  return { host, trip: (reason: string) => { if (internals.tripped === undefined) internals.tripped = reason; } };
}

function material(host: ServiceCustodyHost, reservation: ServiceUidCustodyV1): Material {
  const h = HOSTS.get(host);
  if (h === undefined) return denied("requires a sealed host");
  const lifecycleUid = assertLifecycleToken(reservation?.native?.lifecycleUid);
  const uidBytes = enc.encode(canonicalJson(reservation));
  const custody = parseNativeUidCustody(uidBytes, lifecycleUid);
  if (custody.kind !== "service") return denied("requires a service UID reservation");
  if (custody.uid.native.accountPublicKey !== h.accountPublicKey || custody.uid.native.space !== h.space)
    denied("reservation belongs to another account or space than the host");
  const id = serviceCustodyIdentity(custody.uid);
  const binding: ServiceAssignmentBinding = { accountPublicKey: h.accountPublicKey, space: h.space, owner: id.owner, endpoint: id.endpoint,
    instanceId: id.instanceId, lifecycleUid, assignmentDigest: id.digest };
  return { host: h, id, uidBytes, binding, epgate: serviceGateRows(h.registry, binding) };
}

/** Seal the original admitted bootstrap material once. `notAfterMs` is the creation authority's
 *  fixed deadline; the writer never defaults, extends or resets it. */
export function sealServiceBootstrapIntent(host: ServiceCustodyHost, input: { reservation: ServiceUidCustodyV1; notAfterMs: number }): ServiceBootstrapIntent {
  const m = material(host, input.reservation);
  if (!Number.isSafeInteger(input.notAfterMs) || input.notAfterMs <= 0) denied("bootstrap intent requires an explicit positive notAfterMs");
  const intent: ServiceBootstrapIntent = Object.freeze({ lifecycleUid: m.id.lifecycleUid, notAfterMs: input.notAfterMs });
  BOOTSTRAPS.set(intent, { ...m, notAfterMs: input.notAfterMs });
  return intent;
}

/** Seal an accepted cancellation of this exact reservation. The intent itself does not expire. */
export function sealServiceCancelIntent(host: ServiceCustodyHost, input: { reservation: ServiceUidCustodyV1; opId: string; requestDigest: string }): ServiceCancelIntent {
  const m = material(host, input.reservation);
  const opId = assertLifecycleToken(input.opId, "opId");
  if (typeof input.requestDigest !== "string" || !isContractDigest(input.requestDigest)) denied("cancel intent requires a request digest");
  const intent: ServiceCancelIntent = Object.freeze({ lifecycleUid: m.id.lifecycleUid, opId });
  CANCELS.set(intent, { ...m, op: { kind: "service-cancel", opId, requestDigest: input.requestDigest } });
  return intent;
}

// ---- held control flow, readiness and bounded broker access ----------------------------------

class Held extends Error {
  constructor(readonly reason: string, readonly step: string, detail: string) { super(detail); }
}
function held(reason: string, step: string, detail = reason): never {
  throw new Held(reason, step, detail);
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Ctx { h: HostInternals; jsm: JetStreamManager; kv: { records: KV; auth: KV }; bucket: { records: string; auth: string }; deadlineMs: number; step: string }

function context(h: HostInternals, deadlineMs: number): Ctx {
  const stores = registryStores(h.registry);
  return { h, jsm: stores.jsm, kv: { records: stores.recordsKv, auth: stores.authKv },
    bucket: { records: recordsBucket(h.space), auth: epAuthBucket(h.space) }, deadlineMs, step: "open" };
}

type Bounded<T> = { ok: true; value: T } | { ok: false; error: unknown } | { ok: false; timedOut: true };

/** Run one broker request with a timeout of `min(S1_REQUEST_TIMEOUT_MS, remaining)`. A request
 *  is never started at or past the deadline. The abandoned request's settlement is still handled. */
async function bounded<T>(ctx: Ctx, start: () => Promise<T>): Promise<Bounded<T>> {
  const ms = Math.min(S1_REQUEST_TIMEOUT_MS, ctx.deadlineMs - Date.now());
  if (ms <= 0) return held("deadline", ctx.step, "the original deadline has passed; no request starts");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; timedOut: true }>((r) => { timer = setTimeout(() => r({ ok: false, timedOut: true }), ms); });
  const settled = start().then((value): Bounded<T> => ({ ok: true, value }), (error): Bounded<T> => ({ ok: false, error }));
  try { return await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
}

async function read<T>(ctx: Ctx, start: () => Promise<T>): Promise<T> {
  const r = await bounded(ctx, start);
  if (r.ok) return r.value;
  return "timedOut" in r ? held("unavailable", ctx.step, "a read timed out") : held("unavailable", ctx.step, message(r.error));
}

function checkSync(ctx: Ctx): void {
  if (ctx.h.tripped !== undefined) held("readiness", ctx.step, `the host is fenced: ${ctx.h.tripped}`);
}

/** Awaited current-hold check before a write. */
async function readyBefore(ctx: Ctx): Promise<void> {
  checkSync(ctx);
  const r = await bounded(ctx, () => ctx.h.assertHeld("before"));
  if (!r.ok) held("readiness", ctx.step, "timedOut" in r ? "the plane claim check timed out" : message(r.error));
  checkSync(ctx);
}

/** Awaited current-hold re-read after a write, then the latch. Any loss here means the write may
 *  have landed under a lost or fenced host: the step reports held, never success. */
async function readyAfter(ctx: Ctx): Promise<void> {
  const r = await bounded(ctx, () => ctx.h.assertHeld("after"));
  if (!r.ok) held("post-write-readiness", ctx.step, "timedOut" in r ? "the post-write plane claim check timed out" : message(r.error));
  if (ctx.h.tripped !== undefined) held("post-write-readiness", ctx.step, `the host was fenced during the write: ${ctx.h.tripped}`);
}

type Leader = { state: "absent" } | { state: "marker"; op: string } | { state: "value"; bytes: Uint8Array; value: unknown; revision: number } | { state: "malformed"; revision: number };

/** Leader-served last message for one key. `absent` means the subject has no message at all. */
async function leader(ctx: Ctx, bucket: "records" | "auth", key: string): Promise<Leader> {
  const name = ctx.bucket[bucket];
  const r = await bounded(ctx, () => ctx.jsm.streams.getMessage(`KV_${name}`, { last_by_subj: `$KV.${name}.${key}` }));
  if (!r.ok) {
    if ("error" in r && (r.error as { code?: unknown })?.code === 10037) return { state: "absent" };
    return held("unavailable", ctx.step, "timedOut" in r ? `the leader read of ${key} timed out` : message(r.error));
  }
  const m = r.value;
  if (!m) return { state: "absent" };
  const op = m.header?.get("KV-Operation");
  if (op) return { state: "marker", op };
  try { return { state: "value", bytes: m.data, value: JSON.parse(dec.decode(m.data)), revision: m.seq }; }
  catch { return { state: "malformed", revision: m.seq }; }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

type Expect = { create: true } | { revision: number; preimage: Uint8Array };

/** One conditional write under readiness. Returns the landed revision, or `moved` when the key no
 *  longer matches this step's decision (the caller re-reads and re-decides). An unknown outcome
 *  is classified by an immediate leader read before anything is reissued; only exact absence for
 *  a create, or the exact preimage at the pinned revision for a CAS, permits the same write again. */
async function write(ctx: Ctx, bucket: "records" | "auth", key: string, bytes: Uint8Array, expect: Expect): Promise<number | "moved"> {
  for (let round = 0; round < S1_MAX_UNKNOWN_ROUNDS; round++) {
    await readyBefore(ctx);
    const kv = ctx.kv[bucket];
    const r = await bounded(ctx, () => ("create" in expect ? kv.put(key, bytes, { previousSeq: 0 }) : kv.update(key, bytes, expect.revision)));
    await readyAfter(ctx);
    if (!r.ok && "error" in r && isCasLoss(r.error)) return "moved";
    const cur = await leader(ctx, bucket, key);
    if (cur.state === "value" && same(cur.bytes, bytes) && ("create" in expect || cur.revision !== expect.revision)) return cur.revision;
    if (r.ok) return "moved";
    const retry = "create" in expect ? cur.state === "absent"
      : cur.state === "value" && cur.revision === expect.revision && same(cur.bytes, expect.preimage);
    if (!retry) return "moved";
  }
  return held("unknown", ctx.step, `the outcome of the write to ${key} stayed unknown`);
}

// ---- classification -----------------------------------------------------------------------------

type EndpointRow = ReturnType<ServiceGateRows["parse"]>;
type EndpointClass = { kind: "absent" } | { kind: "foreign" }
  | { kind: "pending" | "approved" | "revoked"; row: EndpointRow; bytes: Uint8Array; revision: number };

/** Leader-read and classify this assignment's endpoint gate. Every endpoint-gate request is the
 *  writer's own, so none can start after it returns. */
async function endpoint(ctx: Ctx, m: Material): Promise<EndpointClass> {
  const cur = await leader(ctx, "auth", m.epgate.key);
  if (cur.state === "absent") return { kind: "absent" };
  if (cur.state === "marker") return held("endpoint-tombstone", ctx.step, `the endpoint gate carries a ${cur.op} marker`);
  if (cur.state === "malformed") return held("endpoint-malformed", ctx.step, "the endpoint gate is not JSON");
  let row: EndpointRow;
  try { row = m.epgate.parse(cur.bytes); }
  catch (e) {
    if (e instanceof EpEnvelopeError && e.code === "conflict") return { kind: "foreign" };
    return held("endpoint-malformed", ctx.step, message(e));
  }
  const state = row.serviceAuthority.state;
  return { kind: state === "pending-root" ? "pending" : state, row, bytes: cur.bytes, revision: cur.revision };
}

type UidClass = "absent" | "exact" | "foreign" | "marker";

async function uid(ctx: Ctx, m: Material): Promise<UidClass> {
  const cur = await leader(ctx, "records", uidReservationKey(m.id.lifecycleUid));
  if (cur.state === "absent") return "absent";
  if (cur.state === "marker") return "marker";
  if (cur.state === "malformed") return "foreign";
  try {
    const custody = parseNativeUidCustody(cur.bytes, m.id.lifecycleUid);
    return custody.kind === "service" && custody.uidDigest === m.id.digest ? "exact" : "foreign";
  } catch { return "foreign"; }
}

type Parsed<T> = { state: "absent" } | { state: "marker"; detail: string } | { state: "value"; row: T; bytes: Uint8Array; revision: number } | { state: "other"; detail: string };

async function parsed<T>(ctx: Ctx, bucket: "records" | "auth", key: string, parse: (v: unknown) => T): Promise<Parsed<T>> {
  const cur = await leader(ctx, bucket, key);
  if (cur.state === "absent") return cur;
  if (cur.state === "marker") return { state: "marker", detail: `${key} carries a ${cur.op} marker` };
  if (cur.state === "malformed") return { state: "other", detail: `${key} is not JSON` };
  try { return { state: "value", row: parse(cur.value), bytes: cur.bytes, revision: cur.revision }; }
  catch (e) { return { state: "other", detail: message(e) }; }
}

const headKey = (m: Material) => lifecycleHeadKey(m.id.owner, m.id.actor);
const gateKey = (m: Material) => `gate.${m.id.lifecycleUid}`;
const rootKey = (m: Material, credentialId: string) => `cred.${m.id.lifecycleUid}.${credentialId}`;
const head = (ctx: Ctx, m: Material) => parsed(ctx, "records", headKey(m), (v) => parseServiceHead(v, m.id));
const gate = (ctx: Ctx, m: Material) => parsed(ctx, "auth", gateKey(m), (v) => parseServiceNativeGate(v, m.id));
const root = (ctx: Ctx, m: Material, credentialId: string) => parsed(ctx, "auth", rootKey(m, credentialId), (v) => parseServiceNativeRoot(v, m.id, credentialId));
const encodeHead = (m: Material, h: ServiceHead) => encodeRoundTrip(h, (v) => parseServiceHead(v, m.id));
const encodeGate = (m: Material, g: ServiceNativeGate) => encodeRoundTrip(g, (v) => parseServiceNativeGate(v, m.id));
const encodeRoot = (m: Material, r: ServiceNativeRoot) => encodeRoundTrip(r, (v) => parseServiceNativeRoot(v, m.id, r.credentialId));
const rootRow = (m: Material, plan: RootPlan, state: "active" | "revoked"): ServiceNativeRoot => ({
  credentialId: plan.credentialId, holderPrincipal: m.id.holderPrincipal, lifecycleUid: m.id.lifecycleUid, sourceChain: ["root"],
  state, exp: plan.expMs, serviceCustody: { ...m.id.mirror },
});
const headBase = (m: Material) => ({ owner: m.id.owner, actor: m.id.actor, lifecycleUid: m.id.lifecycleUid, managerInstance: m.id.instanceId, processEpoch: 1 as const, serviceCustody: { ...m.id.mirror } });

// ---- bootstrap ----------------------------------------------------------------------------------

type Stop = Exclude<ServiceBootstrapResult, { kind: "active" } | ServiceCustodyHeld>;
class Stopped extends Error { constructor(readonly result: Stop) { super(result.kind); } }
function stop(result: Stop): never {
  throw new Stopped(result);
}

async function endpointRecheck(ctx: Ctx, m: Material): Promise<void> {
  const e = await endpoint(ctx, m);
  if (e.kind === "revoked") stop({ kind: "endpoint-revoked" });
  if (e.kind === "foreign") held("foreign-assignment", ctx.step, "the endpoint gate belongs to another immutable assignment");
}

/** Classify the head for bootstrap; cancelling stops, any non-matching head is a collision. */
function bootstrapHead(ctx: Ctx, h: Parsed<ServiceHead>): Extract<Parsed<ServiceHead>, { state: "absent" | "value" }> {
  if (h.state === "marker") return held("head-tombstone", ctx.step, h.detail);
  if (h.state === "other") return stop({ kind: "identity-collision" });
  if (h.state === "value" && h.row.state === "service-cancelling") stop({ kind: "cancelled", opId: h.row.op.opId });
  return h;
}

async function bootstrap(ctx: Ctx, m: BootstrapSnapshot): Promise<ServiceBootstrapResult> {
  const creationOp = m.id.uid.creation.operationId;
  await readyBefore(ctx);
  ctx.step = "name";
  const name = await bounded(ctx, () => readNativeServiceName(m.host.registry, { accountPublicKey: m.host.accountPublicKey, space: m.host.space }, m.id.endpoint));
  if (!name.ok) {
    if ("error" in name && name.error instanceof EpEnvelopeError && name.error.code === "conflict") return { kind: "name-unbound" };
    return held("unavailable", ctx.step, "timedOut" in name ? "the service name read timed out" : message(name.error));
  }
  if (name.value === undefined || name.value.owner !== m.id.owner) return { kind: "name-unbound" };
  ctx.step = "open";
  await endpointRecheck(ctx, m);

  ctx.step = "B0-uid";
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    const u = await uid(ctx, m);
    if (u === "exact") break;
    if (u === "foreign") return { kind: "uid-burned" };
    if (u === "marker") held("uid-tombstone", ctx.step, "the UID reservation carries a deletion marker");
    await write(ctx, "records", uidReservationKey(m.id.lifecycleUid), m.uidBytes, { create: true });
  }

  ctx.step = "B1-endpoint";
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    const e = await endpoint(ctx, m);
    if (e.kind === "pending" || e.kind === "approved") break;
    if (e.kind === "revoked") return { kind: "endpoint-revoked" };
    if (e.kind === "foreign") held("foreign-assignment", ctx.step, "the endpoint gate belongs to another immutable assignment");
    await write(ctx, "auth", m.epgate.key, m.epgate.pending, { create: true });
  }

  ctx.step = "B2-head";
  let current: ServiceHead | undefined;
  for (let i = 0; current === undefined; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    const h = bootstrapHead(ctx, await head(ctx, m));
    if (h.state === "value") { current = h.row; break; }
    const creating: ServiceHead = { ...headBase(m), state: "service-creating", op: { kind: "service-create", opId: creationOp, requestDigest: m.id.uid.creation.requestDigest }, rootPlan: null };
    await write(ctx, "records", headKey(m), encodeHead(m, creating), { create: true });
  }
  if (current.state === "active") return verify(ctx, m, current.currentCredentialId);

  ctx.step = "B3-gate";
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    const g = await gate(ctx, m);
    if (g.state === "other" || g.state === "marker") held("gate-foreign", ctx.step, g.detail);
    if (g.state === "absent") {
      const frozen: ServiceNativeGate = { lifecycleUid: m.id.lifecycleUid, state: "frozen", generation: 0, serviceCustody: { ...m.id.mirror }, op: { opId: creationOp, kind: "activation" } };
      await write(ctx, "auth", gateKey(m), encodeGate(m, frozen), { create: true });
      continue;
    }
    const row = g.row;
    if (row.state === "open") break;
    if (row.op.kind === "service-cancel") return { kind: "cancelled", opId: row.op.opId };
    if (row.op.opId !== creationOp || row.generation !== 0) held("gate-foreign", ctx.step, "the frozen native gate belongs to another operation");
    ctx.step = "B4-open";
    const open: ServiceNativeGate = { lifecycleUid: m.id.lifecycleUid, state: "open", generation: 1, serviceCustody: { ...m.id.mirror } };
    await write(ctx, "auth", gateKey(m), encodeGate(m, open), { revision: g.revision, preimage: g.bytes });
    ctx.step = "B3-gate";
  }

  ctx.step = "B5-plan";
  let plan: RootPlan | undefined;
  for (let i = 0; plan === undefined; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    await endpointRecheck(ctx, m);
    const h = bootstrapHead(ctx, await head(ctx, m));
    if (h.state === "absent") held("head-vanished", ctx.step, "the creating head is no longer readable");
    if (h.row.state === "active") return verify(ctx, m, h.row.currentCredentialId);
    if (h.row.state !== "service-creating") return held("head-foreign", ctx.step);
    if (h.row.rootPlan !== null) { plan = h.row.rootPlan; break; }
    // Fixed once: the id and expiry are chosen here and only a winning CAS persists them.
    const candidate: RootPlan = { credentialId: mintLifecycleUid(), expMs: Date.now() + ROOT_CREDENTIAL_TTL_MS };
    await write(ctx, "records", headKey(m), encodeHead(m, { ...h.row, rootPlan: candidate }), { revision: h.revision, preimage: h.bytes });
  }

  ctx.step = "B6-root";
  await endpointRecheck(ctx, m);
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    if (Date.now() >= plan.expMs) held("plan-expired", ctx.step, "the persisted root plan has expired; cancel this incarnation");
    const h = bootstrapHead(ctx, await head(ctx, m));
    if (h.state === "absent" || h.row.state !== "service-creating" || h.row.rootPlan?.credentialId !== plan.credentialId) {
      if (h.state === "value" && h.row.state === "active") return verify(ctx, m, h.row.currentCredentialId);
      held("head-moved", ctx.step, "the creating head no longer carries this plan");
    }
    const r = await root(ctx, m, plan.credentialId);
    if (r.state === "other" || r.state === "marker") held("root-foreign", ctx.step, r.detail);
    if (r.state === "value") {
      if (r.row.exp !== plan.expMs) held("root-foreign", ctx.step, "the planned root row carries another expiry");
      // A revoked planned root is a cancellation's D4 fence; the re-read head names its operation.
      if (r.row.state === "revoked") { bootstrapHead(ctx, await head(ctx, m)); held("root-revoked", ctx.step, "the planned root is revoked under a creating head"); }
      break;
    }
    await write(ctx, "auth", rootKey(m, plan.credentialId), encodeRoot(m, rootRow(m, plan, "active")), { create: true });
  }

  ctx.step = "B7-finalize";
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_GATE_REPIN) held("contention", ctx.step);
    const g = await gate(ctx, m);
    if (g.state !== "value") held("gate-foreign", ctx.step, g.state === "absent" ? "the native gate vanished" : g.detail);
    if (g.row.state === "frozen") {
      if (g.row.op.kind === "service-cancel") return { kind: "cancelled", opId: g.row.op.opId };
      held("gate-foreign", ctx.step, "the native gate is frozen under another operation");
    }
    // Identical-bytes touch: a sibling's touch is benign and re-pins; anything else refuses.
    if ((await write(ctx, "auth", gateKey(m), g.bytes, { revision: g.revision, preimage: g.bytes })) !== "moved") break;
  }

  ctx.step = "B8-stamp";
  await endpointRecheck(ctx, m);
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    if (Date.now() >= plan.expMs) held("plan-expired", ctx.step, "the persisted root plan has expired; cancel this incarnation");
    const h = bootstrapHead(ctx, await head(ctx, m));
    if (h.state === "absent") held("head-vanished", ctx.step, "the creating head is no longer readable");
    if (h.row.state === "active") {
      if (h.row.currentCredentialId !== plan.credentialId) held("head-foreign", ctx.step, "the active head stamps another root");
      break;
    }
    if (h.row.state !== "service-creating" || h.row.rootPlan?.credentialId !== plan.credentialId) held("head-moved", ctx.step);
    const active: ServiceHead = { ...headBase(m), state: "active", currentCredentialId: plan.credentialId };
    await write(ctx, "records", headKey(m), encodeHead(m, active), { revision: h.revision, preimage: h.bytes });
  }
  return verify(ctx, m, plan.credentialId);
}

/** B9: the root coordinate is returned only after the unchanged active-root reader proves it and
 *  the endpoint is not revoked. No connect-reader proof is claimed here. */
async function verify(ctx: Ctx, m: Material, credentialId: string): Promise<ServiceBootstrapResult> {
  ctx.step = "B9-verify";
  const proof = await bounded(ctx, () => readRegistryServiceRoot(m.host.registry, m.binding, credentialId, Date.now()));
  if (!proof.ok) {
    const h = await head(ctx, m);
    if (h.state === "value" && h.row.state === "service-cancelling") return { kind: "cancelled", opId: h.row.op.opId };
    return held("verify", ctx.step, "timedOut" in proof ? "the root proof timed out" : message(proof.error));
  }
  await endpointRecheck(ctx, m);
  const r = await root(ctx, m, credentialId);
  if (r.state !== "value" || r.row.state !== "active") held("verify", ctx.step, "the proven root row is not readable as active");
  return { kind: "active", root: { credentialId, expMs: r.row.exp } };
}

/** Bootstrap the exact sealed reservation toward an active stamped root, resuming any durable
 *  progress of the same creation. Every request is bounded by the intent's original deadline. */
export async function runServiceBootstrap(intent: ServiceBootstrapIntent): Promise<ServiceBootstrapResult> {
  const m = BOOTSTRAPS.get(intent);
  if (m === undefined) return denied("requires a sealed bootstrap intent");
  const ctx = context(m.host, m.notAfterMs);
  try { return await bootstrap(ctx, m); }
  catch (e) {
    if (e instanceof Stopped) return e.result;
    if (e instanceof Held) return { kind: "held", reason: e.reason, step: e.step, detail: e.message, opId: m.id.uid.creation.operationId };
    return { kind: "held", reason: "unavailable", step: ctx.step, detail: message(e), opId: m.id.uid.creation.operationId };
  }
}

// ---- cancellation -------------------------------------------------------------------------------

class Refused extends Error { constructor(readonly result: Exclude<ServiceCancelResult, { kind: "pending" } | ServiceCustodyHeld>) { super(result.kind); } }
function refuse(result: Refused["result"]): never {
  throw new Refused(result);
}
const sameOp = (a: CancelOp, b: CancelOp) => a.opId === b.opId && a.requestDigest === b.requestDigest;

async function confirmCancelling(ctx: Ctx, m: CancelSnapshot): Promise<Extract<ServiceHead, { state: "service-cancelling" }>> {
  const h = await head(ctx, m);
  if (h.state !== "value" || h.row.state !== "service-cancelling") return held("head-moved", ctx.step, "the cancelling head is not readable");
  if (!sameOp(h.row.op, m.op)) refuse({ kind: "foreign-operation", opId: h.row.op.opId });
  return h.row;
}

async function cancel(ctx: Ctx, m: CancelSnapshot): Promise<ServiceCancelResult> {
  const opId = m.op.opId;
  await readyBefore(ctx);
  ctx.step = "U-uid";
  const u = await uid(ctx, m);
  if (u === "foreign" || u === "marker") return { kind: "uid-foreign" };

  ctx.step = "L1-endpoint";
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    const e = await endpoint(ctx, m);
    if (e.kind === "revoked") break;
    if (e.kind === "foreign") held("foreign-assignment", ctx.step, "the endpoint gate belongs to another immutable assignment");
    if (e.kind === "absent") { await write(ctx, "auth", m.epgate.key, m.epgate.uncreatedFence(opId), { create: true }); continue; }
    const next = m.epgate.deny(e.row, opId);
    if (next === undefined) break;
    await write(ctx, "auth", m.epgate.key, next, { revision: e.revision, preimage: e.bytes });
  }
  if (u === "absent") {
    // D3: endpoint-only denied residue under this intent. No head, gate or root authority.
    if ((await uid(ctx, m)) !== "exact") return { kind: "uid-unconfirmed", held: true, opId };
  }

  ctx.step = "L2-head";
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    const h = await head(ctx, m);
    if (h.state === "other" || h.state === "marker") held("head-foreign", ctx.step, h.detail);
    let next: ServiceHead;
    if (h.state === "absent") {
      next = { ...headBase(m), state: "service-cancelling", op: m.op, rootPlan: null, currentCredentialId: null };
      await write(ctx, "records", headKey(m), encodeHead(m, next), { create: true });
      continue;
    }
    const row = h.row;
    if (row.state === "service-cancelling") {
      if (!sameOp(row.op, m.op)) return { kind: "foreign-operation", opId: row.op.opId };
      break;
    }
    if (row.state === "service-creating") {
      next = { ...headBase(m), state: "service-cancelling", op: m.op, rootPlan: row.rootPlan, currentCredentialId: null };
    } else {
      // active -> cancelling: derive the preserved plan from the exact stamped root row, never guess.
      const r = await root(ctx, m, row.currentCredentialId);
      if (r.state !== "value") held("root-unreadable", ctx.step, r.state === "absent" ? "the stamped root row is absent" : r.detail);
      next = { ...headBase(m), state: "service-cancelling", op: m.op, rootPlan: { credentialId: row.currentCredentialId, expMs: r.row.exp }, currentCredentialId: row.currentCredentialId };
    }
    await write(ctx, "records", headKey(m), encodeHead(m, next), { revision: h.revision, preimage: h.bytes });
  }

  ctx.step = "L3-gate";
  for (let i = 0; ; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    await confirmCancelling(ctx, m);
    const g = await gate(ctx, m);
    if (g.state === "other" || g.state === "marker") held("gate-foreign", ctx.step, g.detail);
    const cancelGate = (generation: 0 | 1): ServiceNativeGate => ({ lifecycleUid: m.id.lifecycleUid, state: "frozen", generation, serviceCustody: { ...m.id.mirror }, op: { opId, kind: "service-cancel" } });
    if (g.state === "absent") { await write(ctx, "auth", gateKey(m), encodeGate(m, cancelGate(0)), { create: true }); continue; }
    const row = g.row;
    if (row.state === "frozen" && row.op.kind === "service-cancel") {
      if (row.op.opId !== opId) return { kind: "foreign-operation", opId: row.op.opId };
      break;
    }
    if (row.state === "frozen" && row.op.opId !== m.id.uid.creation.operationId) held("gate-foreign", ctx.step, "the frozen native gate belongs to another operation");
    await write(ctx, "auth", gateKey(m), encodeGate(m, cancelGate(row.generation)), { revision: g.revision, preimage: g.bytes });
  }

  ctx.step = "L4-root";
  const h = await confirmCancelling(ctx, m);
  const pending = (root: "none" | "revoked" | "retained-stamped", rootDetail?: "created-revoked" | "cas-revoked" | "already-revoked"): ServiceCancelResult =>
    ({ kind: "pending", phase: "cancelled-nonterminal", root, ...(rootDetail ? { rootDetail } : {}), opId });
  if (h.currentCredentialId !== null) return pending("retained-stamped");
  if (h.rootPlan === null) return pending("none");
  const plan = h.rootPlan;
  // D4 preconditions, freshly proven: exact reservation, endpoint deny-new, native service-cancel fence.
  if ((await uid(ctx, m)) !== "exact") held("uid-moved", ctx.step);
  if ((await endpoint(ctx, m)).kind !== "revoked") held("endpoint-not-denied", ctx.step);
  const g = await gate(ctx, m);
  if (g.state !== "value" || g.row.state !== "frozen" || g.row.op.kind !== "service-cancel" || g.row.op.opId !== opId) held("gate-not-fenced", ctx.step);
  let detail: "created-revoked" | "cas-revoked" | "already-revoked" | undefined;
  for (let i = 0; detail === undefined; i++) {
    if (i >= S1_MAX_CAS_REDECIDE) held("contention", ctx.step);
    const r = await root(ctx, m, plan.credentialId);
    if (r.state === "other" || r.state === "marker") held("root-foreign", ctx.step, r.detail);
    if (r.state === "absent") {
      if ((await write(ctx, "auth", rootKey(m, plan.credentialId), encodeRoot(m, rootRow(m, plan, "revoked")), { create: true })) !== "moved") detail = "created-revoked";
      continue;
    }
    if (r.row.exp !== plan.expMs) held("root-foreign", ctx.step, "the planned root row carries another expiry");
    if (r.row.state === "revoked") { detail = "already-revoked"; break; }
    if ((await write(ctx, "auth", rootKey(m, plan.credentialId), encodeRoot(m, rootRow(m, plan, "revoked")), { revision: r.revision, preimage: r.bytes })) !== "moved") detail = "cas-revoked";
  }
  return pending("revoked", detail);
}

/** Run one bounded invocation of an accepted cancellation. `deadlineMs` bounds this invocation
 *  only; the same intent may be invoked again and resumes its own durable progress. */
export async function cancelServiceCustody(intent: ServiceCancelIntent, opts: { deadlineMs: number }): Promise<ServiceCancelResult> {
  const m = CANCELS.get(intent);
  if (m === undefined) return denied("requires a sealed cancel intent");
  if (!Number.isSafeInteger(opts.deadlineMs)) denied("cancel invocation requires an explicit deadline");
  const ctx = context(m.host, opts.deadlineMs);
  try { return await cancel(ctx, m); }
  catch (e) {
    if (e instanceof Refused) return e.result;
    if (e instanceof Held) return { kind: "held", reason: e.reason, step: e.step, detail: e.message, opId: m.op.opId };
    return { kind: "held", reason: "unavailable", step: ctx.step, detail: message(e), opId: m.op.opId };
  }
}
