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
  deriveReplySubject, parseEpSubject, EP_AUTHZ_MODES,
  type EpCaller, type ParsedEpRequest, type EpAuthzMode,
} from "./endpoint-subjects.js";
import {
  EpEnvelopeError, parseEndpointRequest, checkRequestSubjectAgreement, assertClassMatches,
  assertArgsValid, assertOutputValid,
  type EndpointRequest, type EndpointReply, type EpClass,
} from "./endpoint-envelope.js";
import { compileContract, VOID_SCHEMA, type CompiledContract } from "./schema-profile.js";

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
 *  `ephemeral` serves on rails; `journal` refuses at construction). `contract` carries the
 *  COMPILED §13.7 contracts (schema-profile {@link compileContract}): the pinned invocation
 *  digests are DERIVED from each side's `closureDigest`, so the digest a caller pins and the
 *  validator that enforces it travel as one value and can never diverge. `input.validate`
 *  gates args before any effect (`bad-request`), `output.validate` gates before the success
 *  publish (`internal` — an invalid reply is a server bug, §13.3/§13.7). Runtime validation at
 *  the serving boundary is not optional. `targetModes` is the command's REGISTERED §13.2
 *  authorization-mode surface: a targeted request whose subject mode is not listed is
 *  `permission-denied`; absent/empty admits only the untargeted form (default-deny). */
export interface EpCommandDef {
  command: string;
  class: EpClass;
  contract: { input: CompiledContract; output: CompiledContract };
  targetModes?: EpAuthzMode[];
  handler: (ctx: EpServeContext) => Promise<unknown> | unknown;
}

/** The internal dispatch shape: registered defs plus the ONE reserved describe. `digests` is
 *  absent exactly for describe (it pins no contract, §13.7); `validate` is ALWAYS present —
 *  describe validates against the canonical void input and the declared
 *  {@link DescribeAnswer} output ({@link describeValidators}). */
interface ActiveDef {
  command: string;
  class: EpClass;
  digests?: { input: string; output: string };
  validate: { args: ValidateFunction; output: ValidateFunction };
  targetModes: ReadonlySet<string>;
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

const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

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

/** §13.2 registered-mode admission at the pre-effect seam: a command serves ONLY the
 *  authorization modes it registered. The subject's mode token is broker-authenticated (the
 *  caller's credential pinned it, §13.9), but the GRANT proves what the caller may claim, not
 *  what this command supports — an unregistered mode is `permission-denied`, before args
 *  validation and before any target resolution. */
function assertModeAdmitted(parsed: ParsedEpRequest, def: ActiveDef): void {
  if (parsed.target === null) return; // the untargeted form is every command's base surface
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
 * Serve `commands` as one instance of `identity.endpoint` on the three §13.2 rails, exactly the
 * per-command forms the serve credential grants (§13.9 {@link epServeSubscribeRows}): the class
 * rail queue-qualified under the canonical queue group (`one` = queue-group anycast), the
 * scatter rail plain, and this instance's own `inst` rail. The reserved `describe` (§13.7:
 * every endpoint MUST serve it) is built HERE from the `describe` parameter — a `describe` def
 * in `commands` refuses at construction, so the authorization seam cannot be replaced by a
 * custom unscoped handler — and the descriptor is bound both to the served surface (its
 * endpoint must be this identity's, every advertised command must have a handler in THIS
 * table) and to the REGISTERED spec: `describe.spec` is the registration this instance runs
 * under, and {@link assertDescriptorMatchesSpec} refuses a descriptor advertising another
 * owner's or an unregistered contract surface at construction.
 *
 * Boundary discipline per message: subject parse (a non-request subject has no sender and is
 * never handled), body validation with the exact §13.3 catalog codes, body-subject agreement,
 * class match against the DEF's declared class, digest binding, registered-mode admission,
 * args schema validation, fresh target currency, then the per-mode fresh authorization
 * (`child`/`ledger` seams) — all before any effect — then dispatch, and budgeted output schema
 * validation before the success publish. A call's reply (success OR structured error) is
 * published on the DERIVED reply subject (§13.2: never a body-supplied target); a cast is
 * never replied to, even on error (§13.5: at-most-once, the caller never reads the rail). A
 * request whose body cannot be parsed carries no trustworthy verb; it is answered (the derived
 * subject is nonce-scoped to this caller, and a cast caller simply holds no subscription
 * there). A reply that does not serialize is replaced by a structured `internal` error reply,
 * never dropped.
 */
export function serveEndpoint(
  nc: NatsConnection,
  space: string,
  identity: EpServeIdentity,
  commands: EpCommandDef[],
  describe: {
    descriptor: DescribeDescriptor;
    authz: DescribeAuthorization;
    /** The REGISTERED service spec this instance runs under (§13.7): binding it here is what
     *  makes discovery authoritative for the registration, not for whatever a composition
     *  happened to pass. */
    spec: { endpoint: string; owner: string; clusterDigests: string[] };
  },
  opts: { resolveTarget?: EpTargetResolver; childAuthority?: EpChildAuthority; ledgerAuthority?: EpLedgerAuthority } = {},
): EpServeHandle {
  const e = endpointToken(identity.endpoint);
  const iId = assertLifecycleToken(identity.instanceId, "instanceId");
  if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 0)
    throw new Error(`epoch ${identity.epoch} is not an unsigned integer`);
  const seen = new Set<string>();
  const defs: ActiveDef[] = [];
  for (const def of commands) {
    assertCommandToken(def.command);
    if (def.command === "describe")
      throw new Error("describe is reserved and built from the describe parameter; a custom describe def would bypass the authorization seam (SPEC 13.7)");
    if (seen.has(def.command)) throw new Error(`command "${def.command}" is served twice`);
    seen.add(def.command);
    if (def.class !== "ephemeral")
      throw new Error(`command "${def.command}" declares class "${def.class}": only ephemeral commands are rail-served; journal work rides epj submissions (SPEC 13.4/13.5)`);
    // §13.7 digest-bound validators: the def carries COMPILED contracts, so the pinned digest
    // is DERIVED from the closure the validator was compiled from — a digest/validator
    // mismatch is unrepresentable, not merely checked.
    if (typeof def.contract?.input?.validate !== "function" || !isDigest(def.contract.input.closureDigest)
      || typeof def.contract?.output?.validate !== "function" || !isDigest(def.contract.output.closureDigest))
      throw new Error(`command "${def.command}" must carry COMPILED contracts (schema-profile compileContract) for both sides: the invocation digest and its enforcing validator travel as one value (SPEC 13.7)`);
    const targetModes = new Set<string>();
    for (const mode of def.targetModes ?? []) {
      if (!(EP_AUTHZ_MODES as readonly string[]).includes(mode))
        throw new Error(`command "${def.command}" registers unknown target mode "${mode}" (SPEC 13.2)`);
      targetModes.add(mode);
    }
    defs.push({
      command: def.command,
      class: def.class,
      digests: { input: def.contract.input.closureDigest, output: def.contract.output.closureDigest },
      validate: { args: def.contract.input.validate, output: def.contract.output.validate },
      targetModes,
      handler: def.handler,
    });
  }
  assertDescriptorShape(describe.descriptor);
  if (endpointToken(describe.descriptor.endpoint) !== e)
    throw new Error(`the descriptor names endpoint "${describe.descriptor.endpoint}" but this instance serves "${identity.endpoint}" (SPEC 13.7: describe is authoritative for ITS endpoint)`);
  assertDescriptorMatchesSpec(describe.descriptor, describe.spec);
  for (const cluster of describe.descriptor.clusters) {
    for (const cmd of cluster.commands) {
      if (cmd !== "describe" && !seen.has(cmd))
        throw new Error(`the descriptor advertises command "${cmd}" with no handler in this serve table (SPEC 13.7: authoritative discovery cannot advertise a nonexistent surface)`);
    }
  }
  defs.push({
    command: "describe",
    class: "ephemeral",
    // describe pins no digests (§13.7) but validates like every command: canonical void args
    // (`bad-request` on any payload, BEFORE the authorization-view lookup) and the declared
    // DescribeAnswer output shape.
    validate: describeValidators(),
    targetModes: new Set(), // §13.7: describe is reserved UNTARGETED; every targeted form refuses
    handler: describeHandler(describe.descriptor, describe.authz),
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
      if (!env.replyExpected) {
        await def.handler({ identity, subject: parsed, request: env });
        return; // cast: the responder MUST NOT reply (§13.5)
      }
      const data = await def.handler({ identity, subject: parsed, request: env });
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
