/**
 * v0.4 serve/describe machinery (SPEC §13.5 verbs, §13.7 "Descriptor and describe", §13.2
 * rails) — the request-boundary dispatch an endpoint instance serves its registered commands
 * through: queue-grouped class serving, the scatter and stable-instance rails, contract-
 * digest-bound invoke with MANDATORY runtime schema validation, structural reply derivation,
 * and the reserved authorization-scoped `describe`.
 *
 * Only EPHEMERAL commands are rail-served: journal work rides `epj` submissions into the
 * canonicalizer and executes off the effects/pool durables (§13.4/§13.5), so a journal-class
 * command def REFUSES at construction, and a request DECLARING `class: journal` on a rail is
 * refused at the boundary. Incarnation fencing is not a subscription shape (§13.9: the epoch
 * is deliberately absent from serve subscriptions): the §13.1 takeover barrier fences a
 * superseded subscriber, every reply carries the responder's epoch in its SUBJECT (attributably
 * stale when superseded), and commits are epoch-fenced at the record seam
 * ({@link writeServiceStatus}).
 */
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import type { ValidateFunction } from "ajv";
import { spacePrefix } from "./subjects.js";
import {
  endpointToken, assertCommandToken, assertLifecycleToken, assertBoundedOwner, epClassQueueGroup,
  deriveReplySubject, parseEpSubject,
  type EpCaller, type ParsedEpRequest,
} from "./endpoint-subjects.js";
import {
  EpEnvelopeError, parseEndpointRequest, checkRequestSubjectAgreement, assertClassMatches,
  assertArgsValid,
  type EndpointRequest, type EndpointReply, type EpClass,
} from "./endpoint-envelope.js";

// ---- the serve table ---------------------------------------------------------------------------

/** The serving instance's identity: its stable logical instance id and fenced process epoch
 *  (§13.1). Both ride every reply SUBJECT (attribution is structural, §13.2). */
export interface EpServeIdentity {
  endpoint: string;
  instanceId: string;
  epoch: number;
}

/** What a handler sees: the broker-authenticated SUBJECT shape (route, caller, target) beside
 *  the validated body — provenance never comes from the body (§13.2/§13.3). */
export interface EpServeContext {
  identity: EpServeIdentity;
  subject: ParsedEpRequest;
  request: EndpointRequest;
}

/** One served command. `class` states the command's declared delivery contract (only
 *  `ephemeral` serves on rails; `journal` refuses at construction). `contract` pins the §13.7
 *  invocation binding; `validate` carries the COMPILED §13.7 validators for the same contract
 *  the digests pin (schema-profile compilation): `args` gates before any effect
 *  (`bad-request`), `output` gates before the success publish (`internal` — an invalid reply
 *  is a server bug, §13.3/§13.7). Both are mandatory: runtime validation at the serving
 *  boundary is not optional. */
export interface EpCommandDef {
  command: string;
  class: EpClass;
  contract: { inputDigest: string; outputDigest: string };
  validate: { args: ValidateFunction; output: ValidateFunction };
  handler: (ctx: EpServeContext) => Promise<unknown> | unknown;
}

/** The internal dispatch shape: registered defs plus the ONE reserved describe. */
interface ActiveDef {
  command: string;
  class: EpClass;
  contract?: { inputDigest: string; outputDigest: string };
  validate?: { args: ValidateFunction; output: ValidateFunction };
  handler: (ctx: EpServeContext) => Promise<unknown> | unknown;
}

/** The FRESH target-resolver seam (§13.3/§13.9: targets resolve by `(alias, lifecycleUid)`
 *  against the CURRENT mapping immediately before effect; static subject/body agreement is not
 *  currency). Returns the alias's current mapping, or `undefined` when the alias has none. The
 *  production reader is the D13 lifecycle registry's leader-served mapping read. */
export type EpTargetResolver = (target: { owner: string; actor: string }) =>
  | Promise<{ lifecycleUid: string; mappingRevision: number } | undefined>
  | { lifecycleUid: string; mappingRevision: number }
  | undefined;

/** §13.3 target currency at the pre-effect seam, for EVERY body-targeted request (call or
 *  cast; a cast has effects too). Fail-closed: no resolver seam means targeted modes are
 *  REFUSED (`unavailable`), never dispatched unchecked; a resolver failure is `unavailable`;
 *  a missing/superseded mapping, a UID mismatch, or a pinned `mappingRevision` mismatch is
 *  `expired` (§13.3). */
async function assertTargetCurrent(env: EndpointRequest, resolve: EpTargetResolver | undefined): Promise<void> {
  const t = env.target;
  if (t === undefined) return;
  if (resolve === undefined)
    throw new EpEnvelopeError("unavailable", "this instance has no trusted target resolver; a targeted request cannot be validated against the current mapping and is refused, never dispatched unchecked (SPEC 13.3/13.9)");
  let mapping: { lifecycleUid: string; mappingRevision: number } | undefined;
  try {
    mapping = await resolve({ owner: t.owner, actor: t.actor });
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `the trusted target resolver failed; refusing the targeted request (SPEC 13.9): ${(err as Error)?.message ?? String(err)}`);
  }
  if (mapping === undefined)
    throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} has no current lifecycle mapping (SPEC 13.3)`);
  if (mapping.lifecycleUid !== t.lifecycleUid)
    throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} expected lifecycle ${t.lifecycleUid} but the current mapping is ${mapping.lifecycleUid} (SPEC 13.3: expired on mapping mismatch)`);
  if (t.mappingRevision !== undefined && mapping.mappingRevision !== t.mappingRevision)
    throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} pinned mappingRevision ${t.mappingRevision} but the current mapping is at ${mapping.mappingRevision} (SPEC 13.3: the pin is exact)`);
}

const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

/** §13.7 invocation binding at the pre-effect seam. `parseEndpointRequest` already enforced
 *  digest PRESENCE for every non-describe command; here the pinned values must EQUAL the served
 *  contract. `describe` has no contract to pin, so a digest carried on it cannot be honored —
 *  `contract-mismatch`, never silently ignored. */
function bindContract(env: EndpointRequest, def: ActiveDef): void {
  if (def.command === "describe") {
    if (env.op.inputDigest !== undefined || env.op.outputDigest !== undefined)
      throw new EpEnvelopeError("contract-mismatch", "describe pins no contract; a digest carried on it cannot be honored (SPEC 13.7)");
    return;
  }
  const c = def.contract!;
  if (env.op.inputDigest !== c.inputDigest || env.op.outputDigest !== c.outputDigest)
    throw new EpEnvelopeError("contract-mismatch", `pinned digests ${env.op.inputDigest}/${env.op.outputDigest} do not match the served contract ${c.inputDigest}/${c.outputDigest}; a member that cannot honor a pinned digest rejects, never coerces (SPEC 13.7)`);
}

// ---- the serve loop ------------------------------------------------------------------------------

export interface EpServeHandle {
  /** Drain every serve subscription, then await every in-flight handler: after `stop()`
   *  resolves this incarnation performs no further effects and publishes no further replies. */
  stop(): Promise<void>;
}

/**
 * Serve `commands` as one instance of `identity.endpoint` on the three §13.2 rails, exactly the
 * per-command forms the serve credential grants (§13.9 {@link epServeSubscribeRows}): the class
 * rail queue-qualified under the canonical queue group (`one` = queue-group anycast), the
 * scatter rail plain, and this instance's own `inst` rail. The reserved `describe` (§13.7:
 * every endpoint MUST serve it) is built HERE from the `describe` parameter — a `describe` def
 * in `commands` refuses at construction, so the authorization seam cannot be replaced by a
 * custom unscoped handler — and the descriptor is bound to the served surface: its endpoint
 * must be this identity's and every advertised command must have a handler in THIS table.
 *
 * Boundary discipline per message: subject parse (a non-request subject has no sender and is
 * never handled), body validation with the exact §13.3 catalog codes, body-subject agreement,
 * class match against the DEF's declared class, digest binding, args schema validation before
 * any effect — then dispatch, and output schema validation before the success publish. A
 * call's reply (success OR structured error) is published on the DERIVED reply subject (§13.2:
 * never a body-supplied target); a cast is never replied to, even on error (§13.5:
 * at-most-once, the caller never reads the rail). A request whose body cannot be parsed
 * carries no trustworthy verb; it is answered (the derived subject is nonce-scoped to this
 * caller, and a cast caller simply holds no subscription there). A reply that does not
 * serialize is replaced by a structured `internal` error reply, never dropped.
 */
export function serveEndpoint(
  nc: NatsConnection,
  space: string,
  identity: EpServeIdentity,
  commands: EpCommandDef[],
  describe: { descriptor: DescribeDescriptor; authz: DescribeAuthorization },
  opts: { resolveTarget?: EpTargetResolver } = {},
): EpServeHandle {
  const e = endpointToken(identity.endpoint);
  const iId = assertLifecycleToken(identity.instanceId, "instanceId");
  if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 0)
    throw new Error(`epoch ${identity.epoch} is not an unsigned integer`);
  const seen = new Set<string>();
  for (const def of commands) {
    assertCommandToken(def.command);
    if (def.command === "describe")
      throw new Error("describe is reserved and built from the describe parameter; a custom describe def would bypass the authorization seam (SPEC 13.7)");
    if (seen.has(def.command)) throw new Error(`command "${def.command}" is served twice`);
    seen.add(def.command);
    if (def.class !== "ephemeral")
      throw new Error(`command "${def.command}" declares class "${def.class}": only ephemeral commands are rail-served; journal work rides epj submissions (SPEC 13.4/13.5)`);
    if (!def.contract || !isDigest(def.contract.inputDigest) || !isDigest(def.contract.outputDigest))
      throw new Error(`command "${def.command}" must pin its contract digests (SPEC 13.7: required on every command except describe)`);
    if (typeof def.validate?.args !== "function" || typeof def.validate?.output !== "function")
      throw new Error(`command "${def.command}" must carry compiled args + output validators (SPEC 13.7: runtime validation at the serving boundary is mandatory)`);
  }
  assertDescriptorShape(describe.descriptor);
  if (endpointToken(describe.descriptor.endpoint) !== e)
    throw new Error(`the descriptor names endpoint "${describe.descriptor.endpoint}" but this instance serves "${identity.endpoint}" (SPEC 13.7: describe is authoritative for ITS endpoint)`);
  for (const cluster of describe.descriptor.clusters) {
    for (const cmd of cluster.commands) {
      if (cmd !== "describe" && !seen.has(cmd))
        throw new Error(`the descriptor advertises command "${cmd}" with no handler in this serve table (SPEC 13.7: authoritative discovery cannot advertise a nonexistent surface)`);
    }
  }
  const defs: ActiveDef[] = [
    ...commands,
    { command: "describe", class: "ephemeral", handler: describeHandler(describe.descriptor, describe.authz) },
  ];

  const p = spacePrefix(space);
  const subs: Subscription[] = [];
  const pending = new Set<Promise<void>>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const handle = async (def: ActiveDef, msg: { subject: string; data: Uint8Array }): Promise<void> => {
    const parsed = parseEpSubject(msg.subject);
    if (!parsed || parsed.plane !== "request") return; // no sender: MUST NOT be handled (§13.2)
    let env: EndpointRequest | undefined;
    let reply: EndpointReply;
    try {
      env = parseEndpointRequest(JSON.parse(dec.decode(msg.data)));
      checkRequestSubjectAgreement(env, parsed);
      assertClassMatches(env, def.class);
      bindContract(env, def);
      // §13.7: args validate against the input schema BEFORE any effect (bad-request).
      if (def.validate) assertArgsValid(def.validate.args, env.args);
      // §13.3/§13.9: target currency resolves against the FRESH mapping immediately before
      // effect — static agreement is not currency; casts have effects too.
      await assertTargetCurrent(env, opts.resolveTarget);
      if (!env.replyExpected) {
        await def.handler({ identity, subject: parsed, request: env });
        return; // cast: the responder MUST NOT reply (§13.5)
      }
      const data = await def.handler({ identity, subject: parsed, request: env });
      // §13.7: the reply validates against the output schema BEFORE it is published — an
      // invalid reply is a server bug and fails loud, never reaches the caller as success.
      if (def.validate && !def.validate.output(data === undefined ? null : data))
        throw new EpEnvelopeError("internal", "handler output does not validate against the output schema; refusing to publish an invalid reply (SPEC 13.7)");
      reply = { v: 1, id: env.id, ok: true, ...(data !== undefined ? { data } : {}) };
    } catch (err) {
      if (env && !env.replyExpected) return; // a failed cast stays silent (§13.5 at-most-once)
      const error = err instanceof EpEnvelopeError
        ? err.toEpError()
        : { code: "internal", message: (err as Error)?.message ?? String(err) };
      // The id echoes the request where one parsed; the reply subject is already nonce-scoped
      // to exactly this request's caller, so attribution never rides the echo.
      reply = { v: 1, id: env?.id ?? "invalid", ok: false, error };
    }
    let bytes: Uint8Array;
    try {
      bytes = enc.encode(JSON.stringify(reply));
    } catch (err) {
      // A non-serializable success payload (cycle, BigInt) must not silently drop the reply.
      const fallback: EndpointReply = { v: 1, id: reply.id, ok: false, error: { code: "internal", message: `the reply does not serialize: ${(err as Error).message}` } };
      bytes = enc.encode(JSON.stringify(fallback));
    }
    nc.publish(deriveReplySubject(space, parsed, identity), bytes);
  };

  for (const def of defs) {
    const cmd = def.command;
    const cb = (_err: unknown, msg: { subject: string; data: Uint8Array }) => {
      const run = handle(def, msg).catch(() => { /* handle() reports via the reply; never unhandled */ });
      pending.add(run);
      void run.finally(() => pending.delete(run));
    };
    subs.push(nc.subscribe(`${p}.ep.one.${e}.${cmd}.>`, { queue: epClassQueueGroup(identity.endpoint), callback: cb }));
    subs.push(nc.subscribe(`${p}.ep.all.${e}.${cmd}.>`, { callback: cb }));
    subs.push(nc.subscribe(`${p}.ep.inst.${e}.${iId}.${cmd}.>`, { callback: cb }));
  }

  return {
    async stop() {
      await Promise.all(subs.map((s) => s.drain())); // no new deliveries
      await Promise.allSettled([...pending]); // in-flight handlers finish before "stopped"
    },
  };
}

// ---- describe (§13.7: reserved, untargeted, ephemeral, authorization-scoped) --------------------

/** The authoritative describe answer's descriptor: identity plus the served clusters, each
 *  inline (`document`) or by digest (§13.7). `commands` names what each cluster serves so the
 *  authorization intersection has a unit. */
export interface DescribeDescriptor {
  endpoint: string;
  owner: string;
  endpointType?: string;
  protocol: { v: 1 };
  clusters: { digest: string; commands: string[]; document?: Record<string, unknown> }[];
}

/** A caller's authority view from the TRUSTED source (§13.7): the command set this caller may
 *  see. `undefined` = no fresh view (stale beyond its bound, or the source has no answer) —
 *  describe then fails CLOSED, never answers from a weaker source. */
export interface DescribeView {
  commands: string[];
}

/** The describe authorization seam: either the deployment declared this descriptor PUBLIC (no
 *  view is consulted and the answer says so), or a trusted view provider keyed by the
 *  broker-authenticated caller identity (§13.7: payload/slot-asserted scope is ignored — it is
 *  not even a parameter here). The provider owns its own freshness bound. */
export type DescribeAuthorization =
  | { public: true }
  | { public?: false; view: (caller: EpCaller) => Promise<DescribeView | undefined> | DescribeView | undefined };

/** The describe answer: `public` says which path produced it (§13.7: the answer says so). */
export interface DescribeAnswer {
  public: boolean;
  descriptor: DescribeDescriptor;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Shape-validate a descriptor at construction: bounded owner, pinned protocol, digest-keyed
 *  clusters with token-valid non-empty command lists. */
export function assertDescriptorShape(d: DescribeDescriptor): void {
  endpointToken(d.endpoint);
  assertBoundedOwner(d.owner, "descriptor owner");
  if (d.endpointType !== undefined && typeof d.endpointType !== "string") throw new Error("descriptor endpointType must be a string");
  if (!isRec(d.protocol) || d.protocol.v !== 1) throw new Error("descriptor protocol.v must be 1 (SPEC 13.7: additive evolution)");
  if (!Array.isArray(d.clusters) || d.clusters.length === 0) throw new Error("descriptor needs at least one cluster");
  for (const c of d.clusters) {
    if (!isDigest(c.digest)) throw new Error(`cluster digest ${JSON.stringify(c.digest)} is not a sha256 digest`);
    if (!Array.isArray(c.commands) || c.commands.length === 0) throw new Error(`cluster ${c.digest} advertises no commands`);
    for (const cmd of c.commands) assertCommandToken(cmd);
    if (c.document !== undefined && !isRec(c.document)) throw new Error(`cluster ${c.digest} inline document must be an object`);
  }
}

/** Bind a descriptor to the REGISTERED spec (§13.7: describe is authoritative for the
 *  registered service): same endpoint, same owner, and exactly the registered cluster digests.
 *  The composition calls this with the spec it registered; discovery can then never advertise
 *  another owner's or an unregistered surface. */
export function assertDescriptorMatchesSpec(
  descriptor: DescribeDescriptor,
  spec: { endpoint: string; owner: string; clusterDigests: string[] },
): void {
  if (endpointToken(descriptor.endpoint) !== endpointToken(spec.endpoint))
    throw new Error(`descriptor endpoint "${descriptor.endpoint}" is not the registered "${spec.endpoint}"`);
  if (descriptor.owner !== spec.owner)
    throw new Error(`descriptor owner "${descriptor.owner}" is not the registered owner "${spec.owner}"`);
  const advertised = descriptor.clusters.map((c) => c.digest).sort();
  const registered = [...spec.clusterDigests].sort();
  if (advertised.length !== registered.length || advertised.some((d, i) => d !== registered[i]))
    throw new Error("descriptor cluster digests do not equal the registered clusterDigests (SPEC 13.7)");
}

/** The reserved describe handler (internal: {@link serveEndpoint} is the only constructor —
 *  §13.7 makes describe mandatory and this seam non-replaceable). The scoped answer intersects
 *  the descriptor against a FRESH trusted view of the caller's authority; an unavailable or
 *  answerless view is `unavailable` (fail closed). An authorized-but-empty intersection is a
 *  valid (empty) answer: describe is the default-granted bootstrap (§13.9), and descriptor
 *  visibility is never inferred from its reachability alone. */
function describeHandler(descriptor: DescribeDescriptor, authz: DescribeAuthorization) {
  return async (ctx: EpServeContext): Promise<DescribeAnswer> => {
    if (endpointToken(descriptor.endpoint) !== endpointToken(ctx.identity.endpoint))
      throw new EpEnvelopeError("internal", "describe descriptor does not name the serving endpoint");
    if (authz.public === true) return { public: true, descriptor };
    let view: DescribeView | undefined;
    try {
      view = await authz.view(ctx.subject.caller);
    } catch (err) {
      throw new EpEnvelopeError("unavailable", `the trusted authorization view failed; describe fails closed, never answers from a weaker source (SPEC 13.7): ${(err as Error)?.message ?? String(err)}`);
    }
    if (view === undefined)
      throw new EpEnvelopeError("unavailable", "no fresh trusted authorization view for this caller; describe fails closed (SPEC 13.7)");
    const allowed = new Set(view.commands);
    const clusters = descriptor.clusters
      .map((c) => {
        const commands = c.commands.filter((cmd) => allowed.has(cmd));
        // The inline document is an OPAQUE cluster artifact core cannot project command-wise:
        // a partial intersection answers by digest only, so a denied command can never leak
        // through the inline copy; the full document rides only a full-cluster authorization.
        const full = commands.length === c.commands.length;
        return { digest: c.digest, commands, ...(full && c.document !== undefined ? { document: c.document } : {}) };
      })
      .filter((c) => c.commands.length > 0);
    return { public: false, descriptor: { ...descriptor, clusters } };
  };
}
