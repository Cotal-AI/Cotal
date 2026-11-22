/** The service host's serving reads: bindings, registration witnesses and snapshots, the native root
 *  and step bounds. openServiceHostOperations builds them once over its closure. */
import { EpEnvelopeError, RECORD_KINDS, canonicalJson, parseServiceSpec, parseServiceStatus, recordSpecKey, recordStatusKey, serviceEndpointActor, verifyClusterManifest, verifyClusterRoot, type ServiceRegistrationSnapshot, type ServiceRegistrationWitness, type ServiceSpec } from "@cotal-ai/core";
import type { ServiceAssignmentBinding, ServiceGateRows } from "./native-service-gate.js";
import { serviceAssignmentGate } from "./service-custody.js";
import { readAssignment, type Inv } from "./service-host-kernel.js";
import type { ServiceHostOperationsOptions, ServiceServeResult } from "./service-host-ops.js";
import type { Assignment, Intent } from "./service-host-records.js";
import { readRegistryServiceRoot } from "./service-root-reader.js";
import { Held, bounded, endpoint, held, leader, message, type Ctx, type EndpointRow, type openServiceCustodyHost } from "./service-write.js";

export type Bound = { state: "bound"; row: Extract<Assignment, { state: "bound" }>; binding: ServiceAssignmentBinding; epgate: ServiceGateRows };
export type Binding = { state: "absent" } | { state: "fenced"; row: Extract<Assignment, { state: "fenced" }> } | Bound;

/** What serviceHostServing reads from the service host closure. Each is a closure constant
 *  bound once at construction, never reassigned, so a destructured copy is the same binding's value. */
export interface ServiceHostServingDeps {
  space: string;
  accountPublicKey: string;
  discovery: ReturnType<typeof openServiceCustodyHost>;
  opts: ServiceHostOperationsOptions;
}

/** The serving reads over one service host's closure. Bodies read their deps by the closure's names. */
export function serviceHostServing(deps: ServiceHostServingDeps) {
  const { space, accountPublicKey, discovery, opts } = deps;
  const deniedServe = (reason: string): ServiceServeResult => ({ state: "denied", reason });
  /** The owner's own assignment at a selector; another owner's reads absent. */
  async function bindingOf(ctx: Ctx, o: string, e: string, i: string): Promise<Binding> {
    const asg = await readAssignment(ctx, e, i);
    if (asg.state === "absent" || asg.row.owner !== o) return { state: "absent" };
    if (asg.row.state === "fenced") return { state: "fenced", row: asg.row };
    return { state: "bound", row: asg.row, ...serviceAssignmentGate(discovery.host, asg.row.reservation) };
  }
  /** A witness is a public coordinate: it must name this selector, owner, actor and lifecycle. */
  const namesBinding = (w: ServiceRegistrationWitness, b: ServiceAssignmentBinding) =>
    namesSelector(w, b) && w.principal.actor === serviceEndpointActor(b) && w.principal.lifecycleUid === b.lifecycleUid;
  /** The part of {@link namesBinding} a selector alone decides, before anything is read. */
  const namesSelector = (w: ServiceRegistrationWitness, s: { owner: string; endpoint: string; instanceId: string }) =>
    w.accountPublicKey === accountPublicKey && w.space === space && w.endpoint === s.endpoint && w.instanceId === s.instanceId && w.principal.owner === s.owner;
  /** The witness of a gate's current registration stamp, or undefined when the gate has none. A stamp
   *  whose coordinates disagree with the gate's is inconsistent and holds. */
  function stampWitness(ctx: Ctx, b: ServiceAssignmentBinding, row: EndpointRow): ServiceRegistrationWitness | undefined {
    const a = row.serviceAuthority, stamp = a.registration;
    if (stamp === undefined) return undefined;
    if (a.rootCredentialId === null || a.approvalDigest === null || stamp.processEpoch !== row.processEpoch
      || stamp.registrationRevision !== row.registrationRevision || stamp.nameAuthorityRevision !== row.nameAuthorityRevision)
      return held("registration-inconsistent", ctx.step, "the registration stamp disagrees with its endpoint gate");
    return { accountPublicKey, space, endpoint: b.endpoint, instanceId: b.instanceId,
      principal: { owner: b.owner, actor: serviceEndpointActor(b), lifecycleUid: b.lifecycleUid },
      rootCredentialId: a.rootCredentialId, approvalDigest: a.approvalDigest, processEpoch: stamp.processEpoch,
      registrationRevision: stamp.registrationRevision, nameAuthorityRevision: stamp.nameAuthorityRevision,
      registrationRequestId: stamp.requestId, registrationProof: stamp.registrationProof };
  }
  /** The closures' manifest and root documents, each verified against its digest. */
  async function closureArtifacts(ctx: Ctx, clusterDigests: string[]): Promise<unknown[]> {
    const reader = opts.serving?.readContractArtifact;
    if (reader === undefined) return held("unavailable", ctx.step, "this host has no contract store reader");
    const get = async (d: string) => {
      const r = await bounded(ctx, () => reader(d));
      if (!r.ok) return held("unavailable", ctx.step, "timedOut" in r ? `the contract artifact ${d} read timed out` : message(r.error));
      return r.value;
    };
    const out: unknown[] = [];
    for (const closure of clusterDigests) {
      const manifest = await get(closure);
      const document = await grammarHeld(ctx, async () => { const { root } = verifyClusterManifest(closure, manifest); const raw = await get(root); verifyClusterRoot(root, raw); return raw; });
      out.push(manifest, document);
    }
    return out;
  }
  /** A read that its own parser or verifier refuses holds as inconsistent, never as absence. */
  async function grammarHeld<T>(ctx: Ctx, f: () => Promise<T> | T): Promise<T> {
    try { return await f(); } catch (e) { if (e instanceof Held) throw e; return held("registration-inconsistent", ctx.step, message(e)); }
  }
  /** The registered spec at the witness revision, the name revision and the closures' artifacts. */
  async function snapshotOf(ctx: Ctx, w: ServiceRegistrationWitness, artifacts?: unknown[]): Promise<ServiceRegistrationSnapshot> {
    const cur = await leader(ctx, "records", recordSpecKey(RECORD_KINDS.svc, [w.endpoint, w.instanceId]));
    if (cur.state !== "value" || cur.revision !== w.registrationRevision)
      return held("registration-inconsistent", ctx.step, "the registered spec is not readable at the witness revision");
    const spec: ServiceSpec = await grammarHeld(ctx, () => parseServiceSpec(cur.value, { endpoint: w.endpoint }));
    if (spec.owner !== w.principal.owner) return held("registration-inconsistent", ctx.step, "the registered spec names another owner");
    return { spec: { value: spec, revision: cur.revision }, name: { authorized: true, revision: w.nameAuthorityRevision }, processEpoch: w.processEpoch,
      contractArtifacts: artifacts ?? await closureArtifacts(ctx, spec.clusterDigests) };
  }
  /** The service-reported ready status at the witness's epoch and spec revision, if recorded. */
  async function reportedAt(ctx: Ctx, w: ServiceRegistrationWitness): Promise<number | undefined> {
    const cur = await leader(ctx, "records", recordStatusKey(RECORD_KINDS.svc, [w.endpoint, w.instanceId]));
    if (cur.state === "absent" || cur.state === "marker") return undefined;
    if (cur.state === "malformed") return held("registration-inconsistent", ctx.step, "the service status is not JSON");
    const status = await grammarHeld(ctx, () => parseServiceStatus(cur.value));
    const at = (status as { reportedAt?: unknown }).reportedAt;
    return status.state === "ready" && status.epoch === w.processEpoch && status.observedSpecRevision === w.registrationRevision
      && typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : undefined;
  }
  /** The live native root's expiry in Unix seconds; a refused proof is a definite refusal. */
  async function rootExpiresAt(ctx: Ctx, inv: Inv, b: ServiceAssignmentBinding, rootCredentialId: string): Promise<number | ServiceServeResult> {
    const r = await bounded(ctx, () => readRegistryServiceRoot(inv.h.registry, b, rootCredentialId, Date.now()));
    if (r.ok) return r.value.expiresAt;
    if ("error" in r && r.error instanceof EpEnvelopeError && r.error.code === "permission-denied") return deniedServe("root-revoked");
    return held("unavailable", ctx.step, "timedOut" in r ? "the native root read timed out" : message(r.error));
  }
  /** Run one native multi-request step to completion or the invocation's original deadline, which
   *  ends the step held; the step's own later requests then fail on the closed connection. */
  async function native<T>(ctx: Ctx, start: () => Promise<T>): Promise<T> {
    const remaining = ctx.deadlineMs - Date.now();
    if (remaining <= 0) return held("deadline", ctx.step, "the original deadline has passed; no request starts");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), remaining); });
    const settled = start().then((value) => ({ value }), (error: unknown) => ({ error }));
    let r: { value: T } | { error: unknown } | "timeout";
    try { r = await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
    if (r === "timeout") return held("deadline", ctx.step, "the original deadline was reached during a native step");
    if ("error" in r) return held("unknown", ctx.step, `the native step did not complete: ${message(r.error)}`);
    return r.value;
  }
  /** Classify the assignment's endpoint gate; anything but an approved or revoked service gate is
   *  inconsistent for a bound selector past approval. */
  async function servedGate(ctx: Ctx, b: Bound) {
    const g = await endpoint(ctx, b);
    if (g.kind !== "approved" && g.kind !== "revoked") return held("registration-inconsistent", ctx.step, `the endpoint gate is ${g.kind}`);
    return g;
  }
  const sameIntent = (a: Intent, b: Intent) => canonicalJson({ ...a, admittedAtMs: 0 }) === canonicalJson({ ...b, admittedAtMs: 0 });

  return { deniedServe, bindingOf, namesBinding, namesSelector, stampWitness, closureArtifacts, grammarHeld, snapshotOf, reportedAt, rootExpiresAt, native, servedGate, sameIntent };
}
