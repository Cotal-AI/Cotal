/**
 * v0.4 serve/describe machinery (SPEC §13.5 verbs, §13.7 "Descriptor and describe", §13.2
 * rails) — the request-boundary dispatch an endpoint instance serves its registered commands
 * through: queue-grouped class serving, the scatter and stable-instance rails, contract-
 * digest-bound invoke, structural reply derivation, and the reserved authorization-scoped
 * `describe`.
 *
 * Only EPHEMERAL commands are rail-served: journal work rides `epj` submissions into the
 * canonicalizer and executes off the effects/pool durables (§13.4/§13.5), so a journal-class
 * command in a serve table is a construction error, and a request DECLARING `class: journal`
 * on a rail is `class-mismatch` at the boundary. Incarnation fencing is not a subscription
 * shape (§13.9: the epoch is deliberately absent from serve subscriptions): the §13.1 takeover
 * barrier fences a superseded subscriber, every reply carries the responder's epoch in its
 * SUBJECT (attributably stale when superseded), and commits are epoch-fenced at the record
 * seam ({@link writeServiceStatus}).
 */
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { spacePrefix } from "./subjects.js";
import {
  endpointToken, assertCommandToken, assertLifecycleToken, epClassQueueGroup,
  deriveReplySubject, parseEpSubject,
  type EpCaller, type ParsedEpRequest,
} from "./endpoint-subjects.js";
import {
  EpEnvelopeError, parseEndpointRequest, checkRequestSubjectAgreement, assertClassMatches,
  type EndpointRequest, type EndpointReply,
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

/** One served command. `contract` pins the §13.7 invocation binding and is REQUIRED for every
 *  command except `describe` (the discovery bootstrap): a serving member rejects an unpinned
 *  or mismatched digest (`contract-mismatch`) before any effect, never coerces. */
export interface EpCommandDef {
  command: string;
  contract?: { inputDigest: string; outputDigest: string };
  handler: (ctx: EpServeContext) => Promise<unknown> | unknown;
}

const isDigest = (v: unknown): v is string => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

/** §13.7 invocation binding at the pre-effect seam. `parseEndpointRequest` already enforced
 *  digest PRESENCE for every non-describe command; here the pinned values must EQUAL the served
 *  contract. `describe` has no contract to pin, so a digest carried on it cannot be honored —
 *  `contract-mismatch`, never silently ignored. */
function bindContract(env: EndpointRequest, def: EpCommandDef): void {
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
  /** Drain every serve subscription (in-flight handlers finish; no new deliveries). */
  stop(): Promise<void>;
}

/**
 * Serve `commands` as one instance of `identity.endpoint` on the three §13.2 rails, exactly the
 * per-command forms the serve credential grants (§13.9 {@link epServeSubscribeRows}): the class
 * rail queue-qualified under the canonical queue group (`one` = queue-group anycast), the
 * scatter rail plain, and this instance's own `inst` rail. Boundary discipline per message:
 * subject parse (a non-request subject has no sender and is never handled), body validation
 * with the exact §13.3 catalog codes, body-subject agreement, class match, digest binding —
 * then dispatch. A call's reply (success OR structured error) is published on the DERIVED
 * reply subject (§13.2: never a body-supplied target); a cast is never replied to, even on
 * error (§13.5: at-most-once, the caller never reads the rail). A request whose body cannot
 * be parsed carries no trustworthy verb; it is answered (the derived subject is nonce-scoped
 * to this caller, and a cast caller simply holds no subscription there).
 */
export function serveEndpoint(
  nc: NatsConnection,
  space: string,
  identity: EpServeIdentity,
  commands: EpCommandDef[],
): EpServeHandle {
  const e = endpointToken(identity.endpoint);
  const iId = assertLifecycleToken(identity.instanceId, "instanceId");
  if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 0)
    throw new Error(`epoch ${identity.epoch} is not an unsigned integer`);
  if (commands.length === 0) throw new Error(`serving "${identity.endpoint}" needs at least one command`);
  const seen = new Set<string>();
  for (const def of commands) {
    assertCommandToken(def.command);
    if (seen.has(def.command)) throw new Error(`command "${def.command}" is served twice`);
    seen.add(def.command);
    if (def.command === "describe") {
      if (def.contract) throw new Error("describe pins no contract (SPEC 13.7: the discovery bootstrap)");
    } else if (!def.contract || !isDigest(def.contract.inputDigest) || !isDigest(def.contract.outputDigest)) {
      throw new Error(`command "${def.command}" must pin its contract digests (SPEC 13.7: required on every command except describe)`);
    }
  }

  const p = spacePrefix(space);
  const subs: Subscription[] = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const handle = async (def: EpCommandDef, msg: { subject: string; data: Uint8Array }): Promise<void> => {
    const parsed = parseEpSubject(msg.subject);
    if (!parsed || parsed.plane !== "request") return; // no sender: MUST NOT be handled (§13.2)
    let env: EndpointRequest | undefined;
    let reply: EndpointReply;
    try {
      env = parseEndpointRequest(JSON.parse(dec.decode(msg.data)));
      checkRequestSubjectAgreement(env, parsed);
      assertClassMatches(env, "ephemeral");
      bindContract(env, def);
      if (!env.replyExpected) {
        await def.handler({ identity, subject: parsed, request: env });
        return; // cast: the responder MUST NOT reply (§13.5)
      }
      const data = await def.handler({ identity, subject: parsed, request: env });
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
    nc.publish(deriveReplySubject(space, parsed, identity), enc.encode(JSON.stringify(reply)));
  };

  for (const def of commands) {
    const cmd = def.command;
    const cb = (errIgnored: unknown, msg: { subject: string; data: Uint8Array }) => { void handle(def, msg); };
    subs.push(nc.subscribe(`${p}.ep.one.${e}.${cmd}.>`, { queue: epClassQueueGroup(identity.endpoint), callback: cb }));
    subs.push(nc.subscribe(`${p}.ep.all.${e}.${cmd}.>`, { callback: cb }));
    subs.push(nc.subscribe(`${p}.ep.inst.${e}.${iId}.${cmd}.>`, { callback: cb }));
  }

  return {
    async stop() {
      await Promise.all(subs.map((s) => s.drain()));
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

/** Build the reserved `describe` command (§13.7: every endpoint MUST serve it). The scoped
 *  answer intersects the descriptor against a FRESH trusted view of the caller's authority;
 *  an unavailable or answerless view is `unavailable` (fail closed). An authorized-but-empty
 *  intersection is a valid (empty) answer: describe is the default-granted bootstrap (§13.9),
 *  and descriptor visibility is never inferred from its reachability alone. */
export function describeCommandDef(descriptor: DescribeDescriptor, authz: DescribeAuthorization): EpCommandDef {
  return {
    command: "describe",
    handler: async (ctx): Promise<DescribeAnswer> => {
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
        .map((c) => ({ ...c, commands: c.commands.filter((cmd) => allowed.has(cmd)) }))
        .filter((c) => c.commands.length > 0);
      return { public: false, descriptor: { ...descriptor, clusters } };
    },
  };
}
