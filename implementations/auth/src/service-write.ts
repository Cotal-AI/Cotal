/** Package-internal shared writer for native service custody: the sealed host, its fatal latch,
 * the bounded broker access and the one conditional write every custody and host-operation step
 * issues. Moved from service-custody.ts unchanged; nothing here decides custody. */
import type { JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError, epAuthBucket, isAccountNkey, isCasLoss, recordsBucket } from "@cotal-ai/core";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import type { ServiceGateRows } from "./native-service-gate.js";
import { genuinePlaneHold, type PlaneClaimHold, type ScanGuard } from "./plane-claim.js";

/** One broker request, clipped to the remaining original deadline. */
export const S1_REQUEST_TIMEOUT_MS = 5_000;

/** Classify-then-retry rounds for a write whose outcome is unknown. */
export const S1_MAX_UNKNOWN_ROUNDS = 3;

export interface ServiceCustodyHost { readonly space: string; readonly accountPublicKey: string }

interface HostInternals { registry: LifecycleRegistry; assertHeld: ScanGuard["assertHeld"]; space: string; accountPublicKey: string; tripped?: string }
const HOSTS = new WeakMap<ServiceCustodyHost, HostInternals>();
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

// ---- held control flow, readiness and bounded broker access ----------------------------------

class Held extends Error {
  constructor(readonly reason: string, readonly step: string, detail: string) { super(detail); }
}
function held(reason: string, step: string, detail = reason): never {
  throw new Held(reason, step, detail);
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `deadlineMs` is the live-authority bound: the original deadline, clipped in bootstrap to the
 *  RootPlan expiry after the plan step. `deadlineReason` names whichever of the two is binding. */
interface Ctx {
  h: HostInternals; jsm: JetStreamManager; kv: { records: KV; auth: KV }; bucket: { records: string; auth: string };
  deadlineMs: number; deadlineReason: "deadline" | "plan-expired"; step: string;
}

function context(h: HostInternals, deadlineMs: number): Ctx {
  const stores = registryStores(h.registry);
  return { h, jsm: stores.jsm, kv: { records: stores.recordsKv, auth: stores.authKv },
    bucket: { records: recordsBucket(h.space), auth: epAuthBucket(h.space) }, deadlineMs, deadlineReason: "deadline", step: "open" };
}

type Bounded<T> = { ok: true; value: T } | { ok: false; error: unknown } | { ok: false; timedOut: true };

/** Run one broker request with a timeout of `min(S1_REQUEST_TIMEOUT_MS, remaining)`. A request
 *  is never started at or past the live-authority bound, and a request still in flight when that
 *  bound is reached ends the step held under the bound's reason. The abandoned request's
 *  settlement is still handled. */
async function bounded<T>(ctx: Ctx, start: () => Promise<T>): Promise<Bounded<T>> {
  const remaining = ctx.deadlineMs - Date.now(), ms = Math.min(S1_REQUEST_TIMEOUT_MS, remaining);
  const bound = ctx.deadlineReason === "plan-expired" ? "the RootPlan expiry" : "the original deadline";
  if (ms <= 0) return held(ctx.deadlineReason, ctx.step, `${bound} has passed; no request starts`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; timedOut: true }>((r) => { timer = setTimeout(() => r({ ok: false, timedOut: true }), ms); });
  const settled = start().then((value): Bounded<T> => ({ ok: true, value }), (error): Bounded<T> => ({ ok: false, error }));
  let r: Bounded<T>;
  try { r = await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
  if (!r.ok && "timedOut" in r && ms === remaining) held(ctx.deadlineReason, ctx.step, `${bound} was reached during a request`);
  return r;
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
 *  a create, or the exact preimage at the pinned revision for a CAS, permits the same write again.
 *  `precheck` runs before every attempt, including each reissue. */
async function write(ctx: Ctx, bucket: "records" | "auth", key: string, bytes: Uint8Array, expect: Expect,
  precheck?: () => Promise<void>): Promise<number | "moved"> {
  for (let round = 0; round < S1_MAX_UNKNOWN_ROUNDS; round++) {
    if (precheck) await precheck();
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
async function endpoint(ctx: Ctx, m: { readonly epgate: ServiceGateRows }): Promise<EndpointClass> {
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

export { HOSTS };
export {
  Held, bounded, context, denied, endpoint, held, leader, message, readyAfter, readyBefore, write,
  type Bounded, type Ctx, type EndpointClass, type EndpointRow, type Expect, type HostInternals, type Leader,
};
