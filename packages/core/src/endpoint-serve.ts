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
 *
 * The principal route (SPEC 13.21) is served here too, by {@link servePrincipalRoute}: both routes
 * run one per-message pipeline, `runRequest`, and differ only in the steps that read the serve
 * grant or the principal's own identity.
 */
import type { Msg, NatsConnection, Subscription } from "@nats-io/transport-node";
import type { ContractValidator } from "./contract-validator.js";
import { spacePrefix } from "./subjects.js";
import {
  endpointToken, assertCommandToken, assertLifecycleToken, epClassQueueGroup,
  deriveReplySubject, parseEpSubject, EP_RAIL_V1, EP_PRINCIPAL_AUTHORITIES,
  derivePrincipalReplySubject, epPrincipalServeFilter, isPrincipalAuthority,
  type EpCaller, type EpPrincipal, type ParsedEpPrincipalRequest, type ParsedEpRequest, type PrincipalAuthority,
} from "./endpoint-subjects.js";
import {
  EpEnvelopeError, parseEndpointRequest, checkRequestSubjectAgreement, assertClassMatches,
  assertArgsValid, assertOutputValid, EP_BIND_REFUSED, EP_TARGET_UNMAPPED,
  type EndpointRequest, type EndpointReply, type EpClass, type EpBindRefusedDetail,
} from "./endpoint-envelope.js";
import { compileContract, assertCompiledContract, singleDocumentClosure, VOID_SCHEMA, type CompiledContract } from "./schema-profile.js";
import { assertServeGrantAuthorized, type EpServeGrant } from "./endpoint-service.js";
import { parseClusterDocument, type ClusterDocument, type DescribeDescriptor } from "./endpoint-cluster.js";
import {
  GOVERNED_TRAIT_URNS, TRAIT_GUARDED, TRAIT_PRICED,
  assertGovernedSurfaceFor, assertGovernedPreEffect, type EpTraitEnforcement,
} from "./endpoint-traits.js";
import type { GuardObligation } from "./endpoint-guard.js";
import { parseDescribeObservation, type DescribeRequestContext } from "./endpoint-describe-observation.js";
import { carriesStoredProvenance } from "./endpoint-provenance.js";

// ---- the serve table ---------------------------------------------------------------------------

/** The serving instance's identity: its stable logical instance id and fenced process epoch
 *  (§13.1). Both ride every reply SUBJECT (attribution is structural, §13.2). */
export interface EpServeIdentity {
  endpoint: string;
  instanceId: string;
  epoch: number;
}

/** What a handler sees: the broker-authenticated SUBJECT shape (route, caller, target) beside
 *  the validated body — provenance never comes from the body (§13.2/§13.3). `obligations` is
 *  present exactly when a guard allowed WITH signed attenuations (§13.6), and every entry is
 *  VERIFIED by the gate (D28 signature, anchor role/scope, window, space + request binding)
 *  before it reaches a handler: the endpoint MUST apply them (monotonic); the applying policy
 *  engine is an extension behind the seam. */
export interface EpServeContext {
  identity: EpServeIdentity;
  subject: ParsedEpRequest;
  request: EndpointRequest;
  /** This process's `performance.now()` when the request arrived, taken before validation. A
   *  host measures a request budget against it in this process only: it is never persisted, sent,
   *  or compared with another process's clock. */
  receivedAtMonotonicMs?: number;
  obligations?: readonly GuardObligation[];
  /** Measure the complete success reply against this connection and a handler's byte ceiling. */
  replyFits?: (data: unknown, ceiling: number) => boolean;
}

const describeContexts = new WeakMap<EpServeContext, DescribeRequestContext>();

/** One served command: its handler plus the COMPILED §13.7 contracts (schema-profile
 *  {@link compileContract} — provenance-branded, so a fabricated `{validate, closureDigest}`
 *  pair refuses at construction). Everything AUTHORITY-shaped about the command — its class,
 *  whether it is targeted and which modes it admits, its schema closure digests — comes from
 *  the serve artifact's digest-VERIFIED registered declaration, never from this def: the def
 *  only supplies the code, and its compiled contracts must EQUAL the registered digests.
 *  `input.validate` gates args before any effect (`bad-request`), `output.validate` gates
 *  before the success publish (`internal` — an invalid reply is a server bug, §13.3/§13.7).
 *  Runtime validation at the serving boundary is not optional. */
export interface EpCommandDef {
  command: string;
  contract: { input: CompiledContract; output: CompiledContract };
  handler: (ctx: EpServeContext) => Promise<unknown> | unknown;
}

/** The internal dispatch shape of one served command, on either route: the declared defs plus
 *  the ONE reserved describe. `digests` is absent exactly for describe (it pins no contract,
 *  §13.7); `validate` is ALWAYS present — describe validates against the canonical void input and
 *  the declared {@link DescribeAnswer} output ({@link describeValidators}). */
interface ServedCommand<C> {
  command: string;
  class: EpClass;
  digests?: { input: string; output: string };
  validate: { args: ContractValidator; output: ContractValidator };
  handler: (ctx: C) => Promise<unknown> | unknown;
}

/** A service-route command. `targeted`/`targetModes` are its REGISTERED §13.2/§13.7 admission
 *  surface, out of verified cluster bytes. */
interface ActiveDef extends ServedCommand<EpServeContext> {
  targeted: boolean;
  targetModes: ReadonlySet<string>;
  /** True iff the REGISTERED declaration carries a governed trait (§13.7): the pre-effect
   *  gate runs for exactly these commands, keyed on the verified governed surface. */
  governed: boolean;
}

/** The FRESH target-resolver seam (§13.3/§13.9: targets resolve by `(alias, lifecycleUid)`
 *  against the CURRENT mapping immediately before effect; static subject/body agreement is not
 *  currency). Returns the alias's current mapping, or `undefined` when the alias has none. The
 *  production reader is the D13 lifecycle registry's leader-served mapping read. */
export type EpTargetResolver = (target: { owner: string; actor: string }) =>
  | Promise<{ lifecycleUid: string; mappingRevision: number } | undefined>
  | { lifecycleUid: string; mappingRevision: number }
  | undefined;

/** The `child`-mode fresh-authorization seam (§13.2): TRUE iff the DURABLE spawner record of
 *  `target` names `caller` as its spawner — read fresh at dispatch, never inferred from the
 *  caller's grant alone (the grant pins the owner domain; the spawner relation is per-entity
 *  state). The production reader is the D13 lifecycle registry's spawner record. */
export type EpChildAuthority = (args: {
  caller: EpCaller;
  target: { owner: string; actor: string; lifecycleUid: string };
}) => Promise<boolean> | boolean;

/** The `ledger`-mode fresh-authorization seam (§13.2): TRUE iff a FRESH read of the
 *  authorization ledger grants `caller` this op on `target`. Fail-closed by construction: no
 *  seam, a seam failure, and a false answer all refuse — a ledger row is never cached into a
 *  dispatch decision. */
export type EpLedgerAuthority = (args: {
  caller: EpCaller;
  target: { owner: string; actor: string; lifecycleUid: string };
  op: { endpoint: string; command: string };
}) => Promise<boolean> | boolean;

/**
 * §13.2/§13.3 INCARNATION ADMISSION — the responder's own answer to "am I the instance this
 * caller bound to?", settled before anything else this request could cause.
 *
 * Without it a class-anycast caller learns the answer only from the reply, by which time the
 * command has run: the effect lands on A while the caller, bound to B, is told the call failed.
 * Nothing that runs on a reply can close that, so the guard has to be on this side of the wire.
 *
 * `bind` is a caller DECLARATION, never authority: it can only make this instance refuse a request
 * the subject already routed here, so it narrows and never widens (§13.3 monotonic attenuation). A
 * different instance is `failed-precondition` (the handle is not stale — the queue simply chose
 * someone else); a different EPOCH on the same instance is `expired`, as everywhere else.
 *
 * Both refusals carry {@link EP_BIND_REFUSED}, meaning NOTHING RAN — true only while this stays
 * ahead of every effect in `runRequest`, including the governed gate, which may consume a one-use
 * priced proof.
 */
function assertBoundIncarnation(env: EndpointRequest, identity: EpServeIdentity): void {
  const b = env.bind;
  if (b === undefined) return;
  if (b.instanceId === identity.instanceId && b.epoch === identity.epoch) return;
  const detail: EpBindRefusedDetail = {
    kind: EP_BIND_REFUSED,
    endpoint: identity.endpoint,
    command: env.op.command,
    boundTo: { instanceId: b.instanceId, epoch: b.epoch },
    servedBy: { instanceId: identity.instanceId, epoch: identity.epoch },
  };
  if (b.instanceId !== identity.instanceId)
    throw new EpEnvelopeError("failed-precondition",
      `this request reached ${identity.endpoint} instance ${identity.instanceId}, but the caller bound to ${b.instanceId}; the class queue chose a different member and "${env.op.command}" WAS NOT RUN - no effect of it exists here. Re-resolve and re-issue, or address one instance (SPEC 13.2)`,
      [detail]);
  throw new EpEnvelopeError("expired",
    `this request reached ${identity.endpoint} instance ${identity.instanceId} at epoch ${identity.epoch}, but the caller bound to epoch ${b.epoch} of the same instance; this incarnation is not the one it resolved against and "${env.op.command}" WAS NOT RUN - no effect of it exists here (SPEC 13.2)`,
    [detail]);
}

/** §13.3 target currency at the pre-effect seam, for EVERY body-targeted request (call or
 *  cast; a cast has effects too). Fail-closed: no resolver seam means targeted modes are
 *  REFUSED (`unavailable`), never dispatched unchecked; a resolver failure is `unavailable`;
 *  a missing/superseded mapping, a UID mismatch, or a pinned `mappingRevision` mismatch is
 *  `expired` (§13.3). A missing mapping is also {@link EP_TARGET_UNMAPPED}, because the
 *  resolver may know only this instance's targets and a sibling may host this one. */
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
    throw new EpEnvelopeError("expired", `this instance holds no current lifecycle mapping for target ${t.owner}.${t.actor} and ran nothing (SPEC 13.3)`,
      [{ kind: EP_TARGET_UNMAPPED }]);
  if (mapping.lifecycleUid !== t.lifecycleUid)
    throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} expected lifecycle ${t.lifecycleUid} but the current mapping is ${mapping.lifecycleUid} (SPEC 13.3: expired on mapping mismatch)`);
  if (t.mappingRevision !== undefined && mapping.mappingRevision !== t.mappingRevision)
    throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} pinned mappingRevision ${t.mappingRevision} but the current mapping is at ${mapping.mappingRevision} (SPEC 13.3: the pin is exact)`);
}

/** §13.7 invocation binding at the pre-effect seam. `parseEndpointRequest` already enforced
 *  digest PRESENCE for every non-describe command; here the pinned values must EQUAL the served
 *  contract. `describe` has no contract to pin (`digests` absent exactly there), so a digest
 *  carried on it cannot be honored — `contract-mismatch`, never silently ignored. */
function bindContract(env: EndpointRequest, def: Pick<ServedCommand<unknown>, "digests">): void {
  if (def.digests === undefined) {
    if (env.op.inputDigest !== undefined || env.op.outputDigest !== undefined)
      throw new EpEnvelopeError("contract-mismatch", "describe pins no contract; a digest carried on it cannot be honored (SPEC 13.7)");
    return;
  }
  if (env.op.inputDigest !== def.digests.input || env.op.outputDigest !== def.digests.output)
    throw new EpEnvelopeError("contract-mismatch", `pinned digests ${env.op.inputDigest}/${env.op.outputDigest} do not match the served contract ${def.digests.input}/${def.digests.output}; a member that cannot honor a pinned digest rejects, never coerces (SPEC 13.7)`);
}

/** §13.2/§13.7 registered admission at the pre-effect seam: a command serves ONLY the form its
 *  verified registered declaration admits. The subject's mode token is broker-authenticated
 *  (the caller's credential pinned it, §13.9), but the GRANT proves what the caller may claim,
 *  not what this command supports — default-deny BOTH ways: a targeted command refuses the
 *  untargeted form (it would bypass the per-mode fresh authorization entirely), an untargeted
 *  command refuses every targeted form, and a targeted request whose mode is not declared is
 *  `permission-denied` — all before args validation and before any target resolution. */
function assertModeAdmitted(parsed: ParsedEpRequest, def: ActiveDef): void {
  if (parsed.target === null) {
    if (def.targeted)
      throw new EpEnvelopeError("permission-denied", `command "${def.command}" is registered TARGETED; the untargeted form is not its surface and would bypass the per-mode fresh authorization (SPEC 13.2/13.7)`);
    return;
  }
  if (!def.targeted)
    throw new EpEnvelopeError("permission-denied", `command "${def.command}" is registered untargeted; a targeted form is not its surface (SPEC 13.2/13.7)`);
  if (!def.targetModes.has(parsed.target.mode))
    throw new EpEnvelopeError("permission-denied", `command "${def.command}" does not admit the "${parsed.target.mode}" authorization mode; a command serves only its registered target modes (SPEC 13.2)`);
}

/** §13.2 per-mode FRESH authorization, after target currency: `child` must find the caller in
 *  the target's durable spawner record, `ledger` must find a live authorization-ledger grant —
 *  both read fresh at dispatch through their seams, both fail CLOSED (`unavailable`) when the
 *  seam is absent or fails, `permission-denied` on a false answer. The other modes carry their
 *  whole authorization in the minted grant + subject agreement (`self`/`owner`/`handle`) or
 *  grant policy alone (`any`) and need no dispatch-time record read. */
async function assertTargetModeAuthorized(
  env: EndpointRequest,
  parsed: ParsedEpRequest,
  opts: { childAuthority?: EpChildAuthority; ledgerAuthority?: EpLedgerAuthority },
): Promise<void> {
  const mode = parsed.target?.mode;
  if (mode !== "child" && mode !== "ledger") return;
  const t = env.target!; // targeted non-self forms carry a body target (subject agreement, §13.3)
  const target = { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid };
  const seam = mode === "child" ? opts.childAuthority : opts.ledgerAuthority;
  if (seam === undefined)
    throw new EpEnvelopeError("unavailable", `this instance has no trusted "${mode}"-mode authority seam; a "${mode}"-targeted request cannot be freshly authorized and is refused, never dispatched on the grant alone (SPEC 13.2)`);
  let authorized: boolean;
  try {
    authorized = mode === "child"
      ? await opts.childAuthority!({ caller: parsed.caller, target })
      : await opts.ledgerAuthority!({ caller: parsed.caller, target, op: { endpoint: env.op.endpoint, command: env.op.command } });
  } catch (err) {
    throw new EpEnvelopeError("unavailable", `the trusted "${mode}"-mode authority seam failed; refusing the targeted request (SPEC 13.2): ${(err as Error)?.message ?? String(err)}`);
  }
  if (!authorized)
    throw new EpEnvelopeError("permission-denied", mode === "child"
      ? `the durable spawner record does not name the caller as ${t.owner}.${t.actor}'s spawner (SPEC 13.2: child mode is a fresh spawner check, never the grant alone)`
      : `the authorization ledger holds no live grant for this caller on ${t.owner}.${t.actor} (SPEC 13.2: ledger mode is a fresh ledger read, fail closed)`);
}

// ---- the shared per-message pipeline (SPEC 13.2, 13.21) -----------------------------------------

/** The route-specific half of the per-message pipeline. {@link runRequest} is the other half and
 *  both routes run it, so a request meets one validator whichever route it rode. A hook refuses by
 *  throwing an {@link EpEnvelopeError}. */
interface RouteSteps<P extends ParsedEpRequest | ParsedEpPrincipalRequest, C, D extends ServedCommand<C>> {
  /** This route's request shape, or `null`: no sender, so it MUST NOT be handled. */
  parse(subject: string): P | null;
  /** Whether this process is the one the request is for, before anything is said about the
   *  command it names. */
  addressed(env: EndpointRequest, parsed: P): void;
  /** The command admits the form the subject names. */
  admit(parsed: P, def: D): void;
  /** The checks that read a seam before the effect. Returns the guard's verified obligations, when
   *  it allowed with some. */
  beforeEffect(env: EndpointRequest, parsed: P, def: D): Promise<readonly GuardObligation[] | undefined>;
  /** The handler's context. */
  context(a: {
    parsed: P; env: EndpointRequest; def: D; subject: string; original: unknown; receivedAtMonotonicMs: number;
    obligations: readonly GuardObligation[] | undefined; replyFits: (data: unknown, ceiling: number) => boolean;
  }): C;
  /** The reply subject, derived from this process and the parsed request. */
  replySubject(parsed: P): string;
  /** Whether a reply may still go out. A route whose stop has stopped waiting drops a late one. */
  mayReply?(): boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function successReply(id: string, data: unknown): EndpointReply {
  return { v: 1, id, ok: true, ...(data !== undefined ? { data } : {}) };
}

function encodeReply(reply: EndpointReply): Uint8Array {
  return enc.encode(JSON.stringify(reply));
}

/** One request through the shared pipeline: subject parse, envelope parse, subject agreement, the
 *  route's addressee check, class match, digest binding, the route's admission, args validation, the
 *  route's seam checks, dispatch, the outcome stamp, and the derived reply. */
async function runRequest<P extends ParsedEpRequest | ParsedEpPrincipalRequest, C, D extends ServedCommand<C>>(
  nc: NatsConnection,
  steps: RouteSteps<P, C, D>,
  pick: (parsed: P) => D | undefined,
  msg: { subject: string; data: Uint8Array },
): Promise<void> {
  const receivedAtMonotonicMs = performance.now();
  const parsed = steps.parse(msg.subject);
  if (!parsed) return; // no sender: MUST NOT be handled (§13.2)
  let env: EndpointRequest | undefined;
  let dispatched = false;
  let returned = false;
  let reply: EndpointReply;
  try {
    const original: unknown = JSON.parse(dec.decode(msg.data));
    env = parseEndpointRequest(original);
    checkRequestSubjectAgreement(env, parsed);
    // §13.2 FIRST among the semantic gates, and deliberately ahead of the command's own class,
    // contract, and args: whether this instance is the addressee at all is settled before
    // anything is said about the command it names. It also has to precede the governed gate,
    // which can consume a one-use priced proof — the refusal claims nothing ran, so nothing may.
    steps.addressed(env, parsed);
    // A route served by one subscription for every command meets a command it does not serve.
    const def = pick(parsed);
    if (def === undefined)
      throw new EpEnvelopeError("unimplemented", `command "${parsed.command}" is not served here`);
    assertClassMatches(env, def.class);
    bindContract(env, def);
    // §13.2: the command admits only its declared form — before args validation, so an
    // unadmitted form learns nothing about the input contract.
    steps.admit(parsed, def);
    // §13.7: args validate against the input schema BEFORE any effect (bad-request).
    assertArgsValid(def.validate.args, env.args);
    const obligations = await steps.beforeEffect(env, parsed, def);
    const requestId = env.id;
    const ctx = steps.context({
      parsed, env, def, subject: msg.subject, original, receivedAtMonotonicMs, obligations,
      replyFits: (data, ceiling) => {
        const maxPayload = nc.info?.max_payload;
        if (!Number.isSafeInteger(maxPayload) || maxPayload === undefined || maxPayload <= 0)
          throw new EpEnvelopeError("unavailable", "the serving connection has no valid payload ceiling");
        if (!Number.isSafeInteger(ceiling) || ceiling <= 0)
          throw new EpEnvelopeError("failed-precondition", "reply byte ceiling must be a positive safe integer");
        return encodeReply(successReply(requestId, data)).byteLength <= Math.min(ceiling, maxPayload);
      },
    });
    dispatched = true;
    if (!env.replyExpected) {
      await def.handler(ctx);
      return; // cast: the responder MUST NOT reply (§13.5)
    }
    const data = await def.handler(ctx);
    returned = true;
    // §13.7: the reply validates against the output schema BEFORE it is published, under the
    // same fixed budget as args — an invalid reply is a server bug and fails loud, never
    // reaches the caller as success.
    assertOutputValid(def.validate.output, data);
    reply = successReply(env.id, data);
  } catch (err) {
    if (env && !env.replyExpected) return; // a failed cast stays silent (§13.5 at-most-once)
    const error = err instanceof EpEnvelopeError
      ? err.toEpError()
      : { code: "internal", message: (err as Error)?.message ?? String(err) };
    // §13.3: a refusal raised before dispatch MUST say nothing ran, one raised after the handler
    // returned MUST say it ran, and an omitted outcome reads as `unknown`. Deciding it here, from
    // where the loop stands, covers every check on either side of the handler, including one
    // added later and a body that never parsed into an envelope. A handler's own throw keeps
    // whatever outcome it stated: the loop cannot tell how far it got.
    // The id echoes the request where one parsed; the reply subject is already nonce-scoped
    // to exactly this request's caller, so attribution never rides the echo.
    const stated = !dispatched ? "not-executed" : returned ? "executed" : undefined;
    reply = { v: 1, id: env?.id ?? "invalid", ok: false, error: stated === undefined ? error : { ...error, outcome: stated } };
  }
  // Replacing a reply that cannot be serialized or published changes nothing about whether the
  // command ran, so each replacement below keeps the outcome the replaced reply stated, and a
  // success states `executed`.
  const outcome = reply.ok ? "executed" : reply.error?.outcome;
  let bytes: Uint8Array;
  try {
    bytes = encodeReply(reply);
  } catch (err) {
    // A non-serializable payload or refusal detail (cycle, BigInt) must not silently drop the reply.
    const fallback: EndpointReply = { v: 1, id: reply.id, ok: false, error: { code: "internal", message: `the reply does not serialize: ${(err as Error).message}`, ...(outcome !== undefined ? { outcome } : {}) } };
    bytes = enc.encode(JSON.stringify(fallback));
  }
  if (steps.mayReply?.() === false) return;
  const replySubject = steps.replySubject(parsed);
  try {
    nc.publish(replySubject, bytes);
  } catch (err) {
    // The publish itself refused the message — a reply over the broker's `max_payload` is the
    // reachable case, and a VALID payload can reach here now that the §13.8 validate budget
    // reports instead of refusing (that throw used to stop an oversized output before it was
    // ever encoded, which masked this path). `runRequest()` is invoked from a subscription
    // callback whose rejection is swallowed by design, so an escaping throw here does not surface
    // anywhere: it leaves the caller with SILENCE until its own deadline. That is precisely the
    // outcome the non-serializable branch above already exists to prevent, so it gets the same
    // treatment. The replacement fits by construction — its message is one integer and a
    // bounded string — and `resource-exhausted` matches the §13.4 fact preflight, which refuses
    // an over-`max_payload` acceptance loudly rather than spilling it.
    const refused: EndpointReply = {
      v: 1, id: reply.id, ok: false,
      error: { code: "resource-exhausted", message: `the serialized reply is ${bytes.length} bytes and the broker refused it (${(err as Error)?.message ?? String(err)}); a reply that cannot be published is refused loudly, never dropped`, ...(outcome !== undefined ? { outcome } : {}) },
    };
    nc.publish(replySubject, enc.encode(JSON.stringify(refused)));
  }
}

// ---- the serve loop ------------------------------------------------------------------------------

export interface EpServeHandle {
  /** Drain every serve subscription, then await every in-flight handler: after `stop()`
   *  resolves this incarnation performs no further effects and publishes no further replies. */
  stop(): Promise<void>;
}

/**
 * Serve an authorized instance's granted commands on the three §13.2 rails, exactly the
 * per-command forms the serve credential grants (§13.9 {@link epServeSubscribeRows}): the class
 * rail queue-qualified under the canonical queue group (`one` = queue-group anycast), the
 * scatter and `inst` rails distributed within each incarnation's queue group. Overlapping
 * connections for one incarnation share dispatch; distinct instances retain scatter delivery.
 * `opts.omitClassCommands` skips the class (`one`) subscribe for named commands only: the credential still grants those rows, the
 * instance and scatter rails still serve them, and `describe` still lists them. A class queue
 * has no nak, so not subscribing is the only way a member does not consume a class request.
 *
 * `serve` is the registry-authorized ARTIFACT {@link authorizeServeGrant} returned — the same
 * value the credential minted from. Construction refuses anything else (brand check), refuses
 * a foreign space, and binds every def to the artifact's digest-VERIFIED registered
 * declaration: the def must be a GRANTED command, its provenance-branded compiled contracts
 * must equal the registered schema digests, its class/targeted/modes come from the verified
 * declaration (a journal-class registered command never rail-serves, so it takes no def), and
 * every granted EPHEMERAL command must have a def (a rail nobody serves is a construction bug);
 * journal commands stay in the credential/descriptor surface but ride epj, so a journal-only or
 * mixed endpoint still constructs and serves describe. The reserved `describe` (§13.7: every endpoint MUST serve it) is built
 * HERE over the artifact's DERIVED deep-frozen descriptor — a `describe` def refuses at
 * construction, so the authorization seam cannot be replaced, and no hand-authored or
 * later-mutated descriptor can reach the wire.
 *
 * Boundary discipline per message: subject parse (a non-request subject has no sender and is
 * never handled), body validation with the exact §13.3 catalog codes, body-subject agreement,
 * class match against the REGISTERED class, digest binding, registered admission (targeted
 * commands refuse the untargeted form and vice versa), args schema validation, fresh target
 * currency, the per-mode fresh authorization (`child`/`ledger` seams), then — because those
 * seams await — target currency AGAIN immediately before dispatch (§13.2/§13.3: a mapping
 * rotated during the authority read must fail, never ride a pre-rotation read into the
 * effect), the §13.7 governed pre-effect gate for a command whose REGISTERED declaration
 * carries a governed trait (guard-then-priced, {@link assertGovernedPreEffect}; construction
 * already refused a governed surface/hook gap, so a bypass is structurally impossible), and
 * budgeted output schema validation before the success publish. A call's reply
 * (success OR structured error) is published on the DERIVED reply subject (§13.2: never a
 * body-supplied target); a cast is never replied to, even on error (§13.5: at-most-once, the
 * caller never reads the rail). A request whose body cannot be parsed carries no trustworthy
 * verb; it is answered (the derived subject is nonce-scoped to this caller, and a cast caller
 * simply holds no subscription there). A reply that does not serialize is replaced by a
 * structured `internal` error reply, never dropped.
 */
export function serveEndpoint(
  nc: NatsConnection,
  space: string,
  serve: EpServeGrant,
  commands: EpCommandDef[],
  describe: DescribeAuthorization,
  opts: {
    resolveTarget?: EpTargetResolver;
    childAuthority?: EpChildAuthority;
    ledgerAuthority?: EpLedgerAuthority;
    /** The §13.9 trait seam: REQUIRED (with the matching hooks) when any granted command's
     *  registered declaration carries a governed trait — construction refuses a governed
     *  command it cannot enforce, and refuses an extraneous enforcement bundle on an
     *  ungoverned surface (fail loud both ways, never a silent no-op). */
    traits?: EpTraitEnforcement;
    /** Commands that stay on scatter + `inst` but are not subscribed on the class `one` rail.
     *  The serve credential still grants the class rows; this only changes what this process
     *  consumes. `describe` is reserved and is never omitted. */
    omitClassCommands?: readonly string[];
  } = {},
): EpServeHandle {
  assertServeGrantAuthorized(serve); // §13.9: the serve table consumes ONLY registry-authorized serve authority
  if (serve.space !== space)
    throw new Error(`the serve artifact was authorized for space "${serve.space}", not "${space}" (SPEC 13.9)`);
  // SPEC 13.21: a command that declares principal-route authority words is served on that route
  // only. Default deny both ways, as for modes: a service route never serves one.
  for (const cmd of serve.commands) {
    if (serve.surface[cmd].authorities !== undefined)
      throw new Error(`command "${cmd}" declares principal-route authorities; a service route never serves it (SPEC 13.21)`);
  }
  const identity: EpServeIdentity = { endpoint: serve.endpoint, instanceId: serve.instanceId, epoch: serve.epoch };
  const e = endpointToken(identity.endpoint);
  const iId = assertLifecycleToken(identity.instanceId, "instanceId");
  const incarnationQueue = `${e}.${iId}.${identity.epoch}`;
  const seen = new Set<string>();
  const defs: ActiveDef[] = [];
  for (const def of commands) {
    assertCommandToken(def.command);
    if (def.command === "describe")
      throw new Error("describe is reserved and built from the serve artifact; a custom describe def would bypass the authorization seam (SPEC 13.7)");
    if (seen.has(def.command)) throw new Error(`command "${def.command}" is served twice`);
    seen.add(def.command);
    const decl = serve.surface[def.command];
    if (decl === undefined)
      throw new Error(`command "${def.command}" is not granted by the serve artifact; the serve table is exactly the granted registered surface (SPEC 13.9)`);
    if (decl.class !== "ephemeral")
      throw new Error(`command "${def.command}" is registered class "${decl.class}": only ephemeral commands are rail-served, so a journal command takes NO rail def; journal work rides epj submissions (SPEC 13.4/13.5)`);
    // §13.7 digest-bound validators: the def carries provenance-BRANDED compiled contracts
    // (a structural {validate, closureDigest} pair refuses — an arbitrary validator cannot
    // wear a registered digest), and their closure digests must EQUAL the verified registered
    // declaration's, so the schema the caller pinned at describe time is the schema this
    // boundary enforces.
    const input = assertCompiledContract(def.contract?.input, `command "${def.command}" input contract`);
    const output = assertCompiledContract(def.contract?.output, `command "${def.command}" output contract`);
    if (input.closureDigest !== decl.inputDigest || output.closureDigest !== decl.outputDigest)
      throw new Error(`command "${def.command}" compiled contracts ${input.closureDigest}/${output.closureDigest} do not equal the registered declaration ${decl.inputDigest}/${decl.outputDigest} (SPEC 13.7: the registered cluster document is the schema authority)`);
    defs.push({
      command: def.command,
      class: decl.class,
      digests: { input: decl.inputDigest, output: decl.outputDigest },
      validate: { args: input.validate, output: output.validate },
      targeted: decl.targeted,
      targetModes: new Set(decl.modes),
      governed: decl.traits.some((t) => GOVERNED_TRAIT_URNS.includes(t)),
      handler: def.handler,
    });
  }
  // Exact coverage applies to the EPHEMERAL (rail-served) subset only: every ephemeral command
  // needs a def (a rail nobody serves is a construction bug), while journal commands stay in the
  // credential/descriptor surface but ride epj submissions, never a rail def — so a journal-only
  // or mixed endpoint constructs and serves its mandatory `describe` (SPEC 13.7), rather than
  // being impossible because the full-surface rule and the journal-rejection rule contradict.
  for (const cmd of serve.commands) {
    const governedUrns = serve.surface[cmd].traits.filter((t) => GOVERNED_TRAIT_URNS.includes(t));
    if (serve.surface[cmd].class !== "ephemeral") {
      // Journal command: no rail def, by design — but a GOVERNED journal command has no
      // enforcement point in this slice (its pre-effect seam is the epj acceptance→effect
      // path), so refusing to construct beats serving governance unenforced (fail closed).
      if (governedUrns.length > 0)
        throw new Error(`journal-class command "${cmd}" declares governed trait(s) ${governedUrns.join(", ")}; the journal-side pre-effect gate is not built in this slice, and a governed command is never served unenforced (SPEC 13.7: fail closed)`);
      continue;
    }
    if (!seen.has(cmd))
      throw new Error(`ephemeral command "${cmd}" has no def in this serve table; the credential subscribes a rail nobody would serve (SPEC 13.9)`);
  }
  // §13.7/§13.9 governed wiring, decided at CONSTRUCTION (a bypass must be structurally
  // impossible, never a first-request surprise): a governed command demands the verified
  // governed surface (branded, bound to exactly THIS grant) plus each trait's hook; an
  // enforcement bundle on an ungoverned surface is a misconfiguration and refuses loudly.
  const governedDefs = defs.filter((d) => d.governed);
  // Capture a CONSTRUCTION-LOCAL enforcement snapshot the dispatch closure binds, so a caller
  // that mutates or swaps `opts.traits` (or its `.governed`) AFTER construction cannot change
  // what the gate enforces — the construction-time validation below is then both necessary AND
  // sufficient (the surface itself is deep-frozen, this closes the whole-object-swap vector).
  let enforcement: EpTraitEnforcement | undefined;
  if (opts.traits === undefined) {
    if (governedDefs.length > 0)
      throw new Error(`command(s) ${governedDefs.map((d) => `"${d.command}"`).join(", ")} declare governed traits and no trait enforcement is wired (opts.traits); missing or unverifiable governed attachments refuse before effect, so construction refuses (SPEC 13.7: fail closed)`);
  } else {
    if (governedDefs.length === 0)
      throw new Error("opts.traits is wired but no granted command declares a governed trait; an extraneous enforcement bundle is a misconfiguration, refused loudly rather than silently ignored (SPEC 13.7)");
    // The guard WIRING is snapshot per-field at construction (engineer MEDIUM: the bundle was
    // copied by reference, so a caller swapping `guard.call` after construction would change
    // what the gate enforces at dispatch): single-read the three fields, validate them as
    // functions HERE (never at first request), and freeze a detached bundle. Invoking the
    // captured `now` per request is intentional - only the function REFERENCES are fixed.
    const guardIn = opts.traits.guard;
    let guard: typeof opts.traits.guard;
    if (guardIn !== undefined) {
      const call = guardIn.call, resolveAnchor = guardIn.resolveAnchor, now = guardIn.now;
      if (typeof call !== "function" || typeof resolveAnchor !== "function" || (now !== undefined && typeof now !== "function"))
        throw new Error("opts.traits.guard must wire `call` and `resolveAnchor` functions (plus an optional `now` clock); a garbled guard seam refuses at construction, never as a first-request surprise (SPEC 13.6)");
      guard = Object.freeze({ call, resolveAnchor, ...(now !== undefined ? { now } : {}) });
    }
    enforcement = { governed: opts.traits.governed, guard, verifyPaymentProof: opts.traits.verifyPaymentProof };
    assertGovernedSurfaceFor(enforcement.governed, serve);
    for (const d of governedDefs) {
      const per = enforcement.governed.commands[d.command];
      if (per?.[TRAIT_GUARDED] !== undefined && enforcement.guard === undefined)
        throw new Error(`command "${d.command}" is guarded and no guard seam is wired; an unreachable guard is deny, so construction refuses rather than denying every request (SPEC 13.6)`);
      // priced ⇒ journal-class (§13.10): a priced effect MUST leave a receipt, and a receipt
      // derives from the journaled acceptance fact — the ephemeral rail records no acceptance,
      // so an ephemeral priced command structurally CANNOT satisfy MUST-emit. Every def in this
      // table is rail-served (ephemeral), hence any priced def here refuses at construction.
      if (per?.[TRAIT_PRICED] !== undefined)
        throw new Error(`command "${d.command}" is priced and declared ephemeral; a priced effect MUST leave a receipt, and a receipt derives from the journaled acceptance fact, so priced implies journal-class (SPEC 13.10) - declare the command class journal`);
    }
  }
  defs.push({
    command: "describe",
    class: "ephemeral",
    // describe pins no digests (§13.7) but validates like every command: canonical void args
    // (`bad-request` on any payload, BEFORE the authorization-view lookup) and the declared
    // DescribeAnswer output shape.
    validate: describeValidators(),
    targeted: false, // §13.7: describe is reserved UNTARGETED; every targeted form refuses
    targetModes: new Set(),
    governed: false, // §13.7: describe is the discovery bootstrap; it carries no traits
    handler: describeHandler(serve.descriptor, describe),
  });

  const omitClass = new Set(opts.omitClassCommands ?? []);
  if (omitClass.has("describe"))
    throw new Error("describe is reserved and every endpoint must serve it on the class rail; omitClassCommands cannot name it (SPEC 13.7)");
  for (const name of omitClass) {
    if (!seen.has(name))
      throw new Error(`omitClassCommands names "${name}", which is not in this serve table`);
  }

  const p = spacePrefix(space);
  const subs: Subscription[] = [];
  const pending = new Set<Promise<void>>();
  const needsDescribeContext = describe.public !== true;
  const steps: RouteSteps<ParsedEpRequest, EpServeContext, ActiveDef> = {
    parse: (subject) => {
      const parsed = parseEpSubject(subject);
      return parsed && parsed.plane === "request" ? parsed : null;
    },
    addressed: (env) => assertBoundIncarnation(env, identity),
    admit: (parsed, def) => assertModeAdmitted(parsed, def),
    beforeEffect: async (env, parsed, def) => {
      // §13.3/§13.9: target currency resolves against the FRESH mapping immediately before
      // effect — static agreement is not currency; casts have effects too.
      await assertTargetCurrent(env, opts.resolveTarget);
      // §13.2: per-mode fresh authorization (child spawner check / ledger read), fail closed.
      await assertTargetModeAuthorized(env, parsed, opts);
      // §13.2/§13.3: the child/ledger seams AWAIT — the mapping can rotate (delete/recreate,
      // revision advance) during that read, so currency is re-resolved AFTER dynamic
      // authorization, immediately before the effect; a pre-rotation read never rides into
      // the handler.
      if (parsed.target?.mode === "child" || parsed.target?.mode === "ledger")
        await assertTargetCurrent(env, opts.resolveTarget);
      if (!def.governed) return undefined;
      // §13.7/§13.9 governed pre-effect gate, for calls AND casts (casts have effects too):
      // guard-then-priced, every anomalous answer refuses, both seams bounded. Construction
      // refused a governed def without enforcement, so the snapshot is present and total here.
      const { obligations } = await assertGovernedPreEffect({
        enforcement: enforcement!,
        endpoint: identity.endpoint,
        command: def.command,
        caller: parsed.caller,
        requestId: env.id,
        space,
        ...(env.auth !== undefined ? { auth: env.auth } : {}),
        ...(env.deadlineMs !== undefined ? { deadlineMs: env.deadlineMs } : {}),
      });
      // §13.2/§13.3 TOCTOU: the gate AWAITED guard/proof, so a target mapping or child/ledger
      // grant can have rotated since the last currency read — re-resolve currency, re-run the
      // dynamic authorization, and then (because the child/ledger authorization is ITSELF an
      // await the mapping can rotate during) re-resolve currency a FINAL time immediately
      // before the effect. This is the SAME currency → auth → currency discipline the
      // pre-gate path above follows; currency → auth alone leaves the last await unfenced.
      // A one-use priced proof MAY be consumed before this refusal fires: fail-closed, no
      // effect occurs, and the caller retries with a fresh request id and proof.
      await assertTargetCurrent(env, opts.resolveTarget);
      await assertTargetModeAuthorized(env, parsed, opts);
      if (parsed.target?.mode === "child" || parsed.target?.mode === "ledger")
        await assertTargetCurrent(env, opts.resolveTarget);
      return obligations;
    },
    context: ({ parsed, env, def, subject, original, receivedAtMonotonicMs, obligations, replyFits }) => {
      const ctx: EpServeContext = {
        identity, subject: parsed, request: env, receivedAtMonotonicMs,
        ...(obligations !== undefined ? { obligations } : {}),
        replyFits,
      };
      if (def.command === "describe" && needsDescribeContext) {
        const observed = parseDescribeObservation(space, subject, original);
        describeContexts.set(ctx, Object.freeze({ subject, fingerprint: observed.fingerprint,
          identity: Object.freeze({ ...identity }), receivedAtMonotonicMs, replyExpected: observed.replyExpected,
          ...(observed.deadlineMs === undefined ? {} : { deadlineMs: observed.deadlineMs }) }));
      }
      return ctx;
    },
    replySubject: (parsed) => deriveReplySubject(space, parsed, identity),
  };

  for (const def of defs) {
    const cmd = def.command;
    const cb = (_err: unknown, msg: Pick<Msg, "subject" | "data" | "headers">) => {
      if (carriesStoredProvenance(msg)) return;
      const run = runRequest(nc, steps, () => def, msg).catch(() => { /* runRequest() reports via the reply; never unhandled */ });
      pending.add(run);
      void run.finally(() => pending.delete(run));
    };
    // Both rails per command (SPEC 13.15): the legacy `ep` and the issued `ep.v1`, each with the
    // same three shapes. The parsed subject carries which one a request rode; the handler reads
    // it off `ctx.subject.rail`, never off the body.
    for (const rail of ["ep", `ep.${EP_RAIL_V1}`]) {
      if (!omitClass.has(cmd))
        subs.push(nc.subscribe(`${p}.${rail}.one.${e}.${cmd}.>`, { queue: epClassQueueGroup(identity.endpoint), callback: cb }));
      subs.push(nc.subscribe(`${p}.${rail}.all.${e}.${cmd}.>`, { queue: incarnationQueue, callback: cb }));
      subs.push(nc.subscribe(`${p}.${rail}.inst.${e}.${iId}.${cmd}.>`, { queue: incarnationQueue, callback: cb }));
    }
  }

  return {
    async stop() {
      // No new deliveries. A drain settles on the server's PONG, and nats-core rejects no pending
      // flush when the connection closes, so a close mid-drain would strand stop() forever: each
      // drain is bounded by the connection's own closed() instead.
      const gone = nc.closed().then(() => undefined);
      await Promise.all(subs.map((s) => Promise.race([s.drain().catch(() => undefined), gone])));
      await Promise.allSettled([...pending]); // in-flight handlers finish before "stopped"
    },
  };
}

// ---- the principal route (SPEC 13.21) -----------------------------------------------------------

/** What a principal-route handler sees: this process, the broker-authenticated caller and the
 *  authority word its row covers, beside the validated body. Nothing about who calls comes from
 *  the body (SPEC 13.21). */
export interface EpPrincipalServeContext {
  endpoint: string;
  /** This process: the head of every request it serves. */
  principal: EpPrincipal;
  /** The caller triple, from the subject. */
  caller: EpCaller;
  /** The authority word of the caller's row, from the subject. */
  authority: PrincipalAuthority;
  request: EndpointRequest;
  /** This process's `performance.now()` when the request arrived, taken before validation. */
  receivedAtMonotonicMs: number;
  /** Measure the complete success reply against this connection and a handler's byte ceiling. */
  replyFits: (data: unknown, ceiling: number) => boolean;
  /** Aborts when the serve stops. A handler that is still running then can end early: stop waits
   *  for it only until its request's deadline, and drops a reply that comes later. */
  signal: AbortSignal;
}

/** One principal-route command: its handler plus the compiled contracts, which MUST equal the
 *  digests the cluster document declares. */
export interface EpPrincipalCommandDef {
  command: string;
  contract: { input: CompiledContract; output: CompiledContract };
  handler: (ctx: EpPrincipalServeContext) => Promise<unknown> | unknown;
}

/** A principal-route command in the dispatch table. */
interface PrincipalDef extends ServedCommand<EpPrincipalServeContext> {
  /** The authority words the declaration admits. `describe` admits every word of the closed set. */
  authorities: ReadonlySet<string>;
}

/** One subscription of a process to its own principal-route subject. */
export interface EpPrincipalServeHandle {
  /** The subject this process serves. */
  readonly filter: string;
  /** Resolves once the broker accepted the subscription: subscribe, flush, and no refusal of that
   *  subject. Rejects with the refusal. */
  readonly ready: Promise<void>;
  /** Resolves with the broker's refusal of the subscription whenever it arrives, also after the
   *  library re-subscribed on a reconnect. Never rejects. */
  readonly refused: Promise<Error>;
  /** Flush and confirm the subscription still stands: the check `ready` ran, run again. */
  check(): Promise<void>;
  /** Unsubscribe, abort every handler's `signal`, then await each handler in flight until its
   *  request's deadline at most. A reply that comes after that is dropped. */
  stop(): Promise<void>;
}

/**
 * Serve a principal's own command set on the principal route (SPEC 13.21), on one connection.
 * `Endpoint.servePrincipal` is the entry point an agent uses: it adds the refusals for an open mesh
 * and a static credential, re-binds on every replaced connection and owns the presence field.
 *
 * The cluster is a core constant, not a registration: construction parses it and refuses a command
 * that declares no `authorities`, one that is not ephemeral, one with a governed trait (this route
 * has no governed gate), and a set of defs that is not exactly the cluster's commands with compiled
 * contracts equal to the declared digests. `describe` is built here: it answers the cluster inline,
 * the same answer for every caller, and admits every authority word.
 *
 * The subscription is this process's own head with no queue group. Each request runs the shared
 * pipeline: a head that is not this process is dropped with no reply, the subject's authority word
 * MUST be one the command declares (`permission-denied`), and the reply goes to the subject derived
 * from this process and the parsed caller, never to a transport reply field.
 *
 * Stopping aborts every handler's `signal` and waits for each handler in flight until its request's
 * `deadlineMs` has passed since the request arrived, and no longer: the caller has stopped waiting
 * by then. A reply that comes later is dropped.
 */
export function servePrincipalRoute(
  nc: NatsConnection,
  space: string,
  self: EpPrincipal,
  serve: { endpoint: string; cluster: ClusterDocument; handlers: EpPrincipalCommandDef[] },
): EpPrincipalServeHandle {
  const filter = epPrincipalServeFilter(space, serve.endpoint, self);
  const cluster = parseClusterDocument(serve.cluster);
  const declared = new Map(cluster.commands.map((c) => [c.name, c]));
  for (const c of cluster.commands) {
    if (c.authorities === undefined)
      throw new Error(`command "${c.name}" declares no authorities; a command is served on the principal route only when it lists the words it admits (SPEC 13.21)`);
    if (c.class !== "ephemeral")
      throw new Error(`command "${c.name}" is class "${c.class}"; the principal route serves ephemeral commands only (SPEC 13.21)`);
    const governed = (c.traits ?? []).filter((t) => GOVERNED_TRAIT_URNS.includes(t));
    if (governed.length > 0)
      throw new Error(`command "${c.name}" declares governed trait(s) ${governed.join(", ")}; the principal route has no governed gate, and a governed command is never served unenforced (SPEC 13.7)`);
  }
  const defs: PrincipalDef[] = [];
  for (const def of serve.handlers) {
    assertCommandToken(def.command);
    if (def.command === "describe")
      throw new Error("describe is reserved and built from the cluster; a custom describe def is refused (SPEC 13.21)");
    if (defs.some((d) => d.command === def.command)) throw new Error(`command "${def.command}" is served twice`);
    const decl = declared.get(def.command);
    if (decl === undefined)
      throw new Error(`command "${def.command}" is not in the cluster; the served table is exactly the cluster's commands (SPEC 13.21)`);
    const input = assertCompiledContract(def.contract?.input, `command "${def.command}" input contract`);
    const output = assertCompiledContract(def.contract?.output, `command "${def.command}" output contract`);
    if (input.closureDigest !== decl.inputDigest || output.closureDigest !== decl.outputDigest)
      throw new Error(`command "${def.command}" compiled contracts ${input.closureDigest}/${output.closureDigest} do not equal the declared ${decl.inputDigest}/${decl.outputDigest} (SPEC 13.7)`);
    defs.push({
      command: def.command, class: "ephemeral",
      digests: { input: decl.inputDigest, output: decl.outputDigest },
      validate: { args: input.validate, output: output.validate },
      authorities: new Set(decl.authorities),
      handler: def.handler,
    });
  }
  for (const c of cluster.commands)
    if (!defs.some((d) => d.command === c.name))
      throw new Error(`command "${c.name}" has no def; a declared command nobody serves is a construction bug (SPEC 13.21)`);
  const answer: DescribeAnswer = deepFreeze({
    public: true,
    descriptor: {
      endpoint: serve.endpoint,
      owner: self.owner,
      protocol: { v: 1 as const },
      clusters: [{
        digest: singleDocumentClosure(serve.cluster).closureDigest,
        commands: cluster.commands.map((c) => c.name),
        document: structuredClone(serve.cluster) as unknown as Record<string, unknown>,
      }],
    },
  });
  defs.push({
    command: "describe",
    class: "ephemeral",
    validate: describeValidators(),
    authorities: new Set(EP_PRINCIPAL_AUTHORITIES),
    handler: () => answer,
  });
  const byCommand = new Map(defs.map((d) => [d.command, d]));

  const steps: RouteSteps<ParsedEpPrincipalRequest, EpPrincipalServeContext, PrincipalDef> = {
    parse: (subject) => {
      const parsed = parseEpSubject(subject);
      if (!parsed || parsed.plane !== "principal-request") return null;
      // The addressee check on this route: a request whose head is not this process was not
      // addressed to it and is dropped with no reply. It needs only the subject, so it runs here.
      const h = parsed.principal;
      if (parsed.endpoint !== serve.endpoint || h.owner !== self.owner || h.actor !== self.actor || h.uid !== self.uid || h.runtimeId !== self.runtimeId)
        return null;
      return parsed;
    },
    addressed: () => {},
    admit: (parsed, def) => {
      if (!isPrincipalAuthority(parsed.authority) || !def.authorities.has(parsed.authority))
        throw new EpEnvelopeError("permission-denied", `command "${def.command}" does not admit the "${parsed.authority}" authority; a command serves only the words its declaration lists (SPEC 13.21)`);
    },
    beforeEffect: async () => undefined,
    context: ({ parsed, env, receivedAtMonotonicMs, replyFits }) => ({
      endpoint: serve.endpoint, principal: self, caller: parsed.caller, authority: parsed.authority,
      request: env, receivedAtMonotonicMs, replyFits, signal: stopping.signal,
    }),
    replySubject: (parsed) => derivePrincipalReplySubject(space, parsed, self),
    mayReply: () => !lateRepliesDropped,
  };

  const stopping = new AbortController();
  let lateRepliesDropped = false;
  /** Each request in flight, with when its caller stops waiting (`performance.now()` time), once
   *  the request has reached its handler. */
  const pending = new Map<Promise<void>, { endsAt?: number }>();
  let refusal: Error | undefined;
  let markRefused!: (e: Error) => void;
  const refused = new Promise<Error>((resolve) => { markRefused = resolve; });
  const sub = nc.subscribe(filter, {
    callback: (err, msg) => {
      if (err) {
        if (refusal === undefined) {
          refusal = new EpEnvelopeError("permission-denied", `the broker refused this process's subscription to its principal-route subject "${filter}": ${err.message}. The credential holds no serve row for it, which a credential minted before the rows existed does not; reconnect after the auth service runs a release that mints them (SPEC 13.21)`);
          markRefused(refusal);
        }
        return;
      }
      if (carriesStoredProvenance(msg)) return;
      const entry: { endsAt?: number } = {};
      const timed: typeof steps = {
        ...steps,
        context: (a) => {
          // The agreement check made `deadlineMs` present on this route.
          entry.endsAt = a.receivedAtMonotonicMs + a.env.deadlineMs!;
          return steps.context(a);
        },
      };
      const run = runRequest(nc, timed, (parsed) => byCommand.get(parsed.command), msg).catch(() => { /* runRequest() reports via the reply; never unhandled */ });
      pending.set(run, entry);
      void run.finally(() => pending.delete(run));
    },
  });
  // A refused subscription arrives as the broker's `-ERR`, which it writes before the `PONG` that
  // answers the flush, and nats-core hands it to the callback above before it settles the flush.
  const check = async (): Promise<void> => {
    await nc.flush();
    if (refusal !== undefined) throw refusal;
  };
  const ready = check();
  ready.catch(() => { /* the caller observes it; this keeps an unobserved refusal from being unhandled */ });
  return {
    filter,
    ready,
    refused,
    check,
    async stop() {
      stopping.abort(new Error(`stopped serving "${serve.endpoint}" on the principal route`));
      const gone = nc.closed().then(() => undefined);
      await Promise.race([sub.drain().catch(() => undefined), gone]);
      // A request that has not reached its handler finishes without waiting on anything outside
      // this process: the route has no seam before the effect.
      await Promise.allSettled([...pending].map(([run, { endsAt }]) =>
        endsAt === undefined ? run : withinMs(run, endsAt - performance.now())));
      lateRepliesDropped = true;
    },
  };
}

/** Settle when `p` does or after `ms`, whichever comes first. */
async function withinMs(p: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

// ---- describe (§13.7: reserved, untargeted, ephemeral, authorization-scoped) --------------------

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
  | { public?: false; view: (caller: EpCaller, context?: DescribeRequestContext) => Promise<DescribeView | undefined> | DescribeView | undefined };

/** The describe answer: `public` says which path produced it (§13.7: the answer says so). */
export interface DescribeAnswer {
  public: boolean;
  descriptor: DescribeDescriptor;
}

/** The declared {@link DescribeAnswer} output schema. The answer's own two fields are closed;
 *  the descriptor level is deliberately OPEN to additive evolution (§13.7: protocol.v stays 1
 *  across additive changes), with the identity, protocol pin, digest grammar, and non-empty
 *  per-cluster command lists enforced (an all-filtered cluster leaves the answer, so an empty
 *  `commands` never appears; an empty `clusters` array is the valid authorized-but-empty
 *  intersection). */
const DESCRIBE_ANSWER_SCHEMA = {
  type: "object",
  required: ["public", "descriptor"],
  additionalProperties: false,
  properties: {
    public: { type: "boolean" },
    descriptor: {
      type: "object",
      required: ["endpoint", "owner", "protocol", "clusters"],
      properties: {
        endpoint: { type: "string", minLength: 1 },
        owner: { type: "string", minLength: 1 },
        endpointType: { type: "string" },
        protocol: { type: "object", required: ["v"], properties: { v: { const: 1 } } },
        clusters: {
          type: "array",
          items: {
            type: "object",
            required: ["digest", "commands"],
            properties: {
              digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
              commands: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              document: { type: "object" },
            },
          },
        },
      },
    },
  },
} as const;

let describeCompiled: { input: CompiledContract; output: CompiledContract } | undefined;
/** The reserved describe's compiled validators (§13.7): the canonical VOID input (a describe
 *  carrying any args is `bad-request` at the same pre-effect seam as every command, BEFORE the
 *  authorization-view lookup) and the declared {@link DescribeAnswer} output. Compiled once,
 *  lazily, through the same profile compiler every registered contract rides. */
function describeValidators(): { args: ContractValidator; output: ContractValidator } {
  const c = describeContracts();
  return { args: c.input.validate, output: c.output.validate };
}

/** The reserved describe's compiled contracts: the canonical void input and the declared
 *  {@link DescribeAnswer} output. A caller validates a describe answer with the output, and pins
 *  neither digest on the request (§13.7). */
export function describeContracts(): { input: CompiledContract; output: CompiledContract } {
  describeCompiled ??= Object.freeze({
    input: compileContract({ root: VOID_SCHEMA }),
    output: compileContract({ root: DESCRIBE_ANSWER_SCHEMA }),
  });
  return describeCompiled;
}

/** The reserved describe handler (internal: {@link serveEndpoint} is the only constructor —
 *  §13.7 makes describe mandatory and this seam non-replaceable). The authorization policy is
 *  SNAPSHOTTED at construction (the discriminant + the view function), so a later mutation of
 *  the caller-supplied `authz` object — flipping `{view}` to `{public:true}` — can never change
 *  what a running describe answers; the descriptor itself is deep-frozen at authorization. The
 *  scoped answer intersects the descriptor against a FRESH trusted view of the caller's
 *  authority; an unavailable or answerless view is `unavailable` (fail closed). An
 *  authorized-but-empty intersection is a valid (empty) answer: describe is the default-granted
 *  bootstrap (§13.9), and descriptor visibility is never inferred from its reachability alone. */
function describeHandler(descriptor: DescribeDescriptor, authz: DescribeAuthorization) {
  const isPublic = authz.public === true;
  // Snapshot the view function once; when not public the union guarantees it is present.
  const viewFn = isPublic ? undefined : authz.view;
  return async (ctx: EpServeContext): Promise<DescribeAnswer> => {
    if (endpointToken(descriptor.endpoint) !== endpointToken(ctx.identity.endpoint))
      throw new EpEnvelopeError("internal", "describe descriptor does not name the serving endpoint");
    if (isPublic) return { public: true, descriptor };
    if (viewFn === undefined)
      throw new EpEnvelopeError("internal", "describe has no snapshotted authorization view but is not public");
    let view: DescribeView | undefined;
    try {
      view = await viewFn!(ctx.subject.caller, describeContexts.get(ctx));
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
