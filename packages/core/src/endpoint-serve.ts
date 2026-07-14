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
  endpointToken, assertCommandToken, assertLifecycleToken, epClassQueueGroup,
  deriveReplySubject, parseEpSubject,
  type EpCaller, type ParsedEpRequest,
} from "./endpoint-subjects.js";
import {
  EpEnvelopeError, parseEndpointRequest, checkRequestSubjectAgreement, assertClassMatches,
  assertArgsValid, assertOutputValid,
  type EndpointRequest, type EndpointReply, type EpClass,
} from "./endpoint-envelope.js";
import { compileContract, assertCompiledContract, VOID_SCHEMA, type CompiledContract } from "./schema-profile.js";
import { assertServeGrantAuthorized, type EpServeGrant } from "./endpoint-service.js";
import type { DescribeDescriptor } from "./endpoint-cluster.js";
import {
  GOVERNED_TRAIT_URNS, TRAIT_GUARDED, TRAIT_PRICED,
  assertGovernedSurfaceFor, assertGovernedPreEffect, type EpTraitEnforcement,
} from "./endpoint-traits.js";
import type { GuardObligation } from "./endpoint-guard.js";

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
  obligations?: readonly GuardObligation[];
}

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

/** The internal dispatch shape: registered defs plus the ONE reserved describe. `digests` is
 *  absent exactly for describe (it pins no contract, §13.7); `validate` is ALWAYS present —
 *  describe validates against the canonical void input and the declared
 *  {@link DescribeAnswer} output ({@link describeValidators}). `targeted`/`targetModes` are
 *  the command's REGISTERED §13.2/§13.7 admission surface, out of verified cluster bytes. */
interface ActiveDef {
  command: string;
  class: EpClass;
  digests?: { input: string; output: string };
  validate: { args: ValidateFunction; output: ValidateFunction };
  targeted: boolean;
  targetModes: ReadonlySet<string>;
  /** True iff the REGISTERED declaration carries a governed trait (§13.7): the pre-effect
   *  gate runs for exactly these commands, keyed on the verified governed surface. */
  governed: boolean;
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

/** §13.7 invocation binding at the pre-effect seam. `parseEndpointRequest` already enforced
 *  digest PRESENCE for every non-describe command; here the pinned values must EQUAL the served
 *  contract. `describe` has no contract to pin (`digests` absent exactly there), so a digest
 *  carried on it cannot be honored — `contract-mismatch`, never silently ignored. */
function bindContract(env: EndpointRequest, def: ActiveDef): void {
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
 * scatter rail plain, and this instance's own `inst` rail.
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
  } = {},
): EpServeHandle {
  assertServeGrantAuthorized(serve); // §13.9: the serve table consumes ONLY registry-authorized serve authority
  if (serve.space !== space)
    throw new Error(`the serve artifact was authorized for space "${serve.space}", not "${space}" (SPEC 13.9)`);
  const identity: EpServeIdentity = { endpoint: serve.endpoint, instanceId: serve.instanceId, epoch: serve.epoch };
  const e = endpointToken(identity.endpoint);
  const iId = assertLifecycleToken(identity.instanceId, "instanceId");
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
      // §13.2: the command admits only its REGISTERED target modes — before args validation,
      // so an unadmitted mode learns nothing about the input contract.
      assertModeAdmitted(parsed, def);
      // §13.7: args validate against the input schema BEFORE any effect (bad-request).
      assertArgsValid(def.validate.args, env.args);
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
      // §13.7/§13.9 governed pre-effect gate, for calls AND casts (casts have effects too):
      // guard-then-priced, every anomalous answer refuses, both seams bounded. Construction
      // refused a governed def without enforcement, so the snapshot is present and total here.
      let obligations: readonly GuardObligation[] | undefined;
      if (def.governed) {
        ({ obligations } = await assertGovernedPreEffect({
          enforcement: enforcement!,
          endpoint: identity.endpoint,
          command: def.command,
          caller: parsed.caller,
          requestId: env.id,
          space,
          ...(env.auth !== undefined ? { auth: env.auth } : {}),
          ...(env.deadlineMs !== undefined ? { deadlineMs: env.deadlineMs } : {}),
        }));
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
      }
      const ctx: EpServeContext = { identity, subject: parsed, request: env, ...(obligations !== undefined ? { obligations } : {}) };
      if (!env.replyExpected) {
        await def.handler(ctx);
        return; // cast: the responder MUST NOT reply (§13.5)
      }
      const data = await def.handler(ctx);
      // §13.7: the reply validates against the output schema BEFORE it is published, under the
      // same fixed budget as args — an invalid reply is a server bug and fails loud, never
      // reaches the caller as success.
      assertOutputValid(def.validate.output, data);
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

/** The reserved describe's compiled validators (§13.7): the canonical VOID input (a describe
 *  carrying any args is `bad-request` at the same pre-effect seam as every command, BEFORE the
 *  authorization-view lookup) and the declared {@link DescribeAnswer} output. Compiled once,
 *  lazily, through the same profile compiler every registered contract rides. */
let describeValidate: { args: ValidateFunction; output: ValidateFunction } | undefined;
function describeValidators(): { args: ValidateFunction; output: ValidateFunction } {
  describeValidate ??= {
    args: compileContract({ root: VOID_SCHEMA }).validate,
    output: compileContract({ root: DESCRIBE_ANSWER_SCHEMA }).validate,
  };
  return describeValidate;
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
      view = await viewFn!(ctx.subject.caller);
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
