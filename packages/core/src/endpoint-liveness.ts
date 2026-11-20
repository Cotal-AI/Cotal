// The peer-readable liveness responder and probe of CotalEndpoint, as an internal component. Moved
// verbatim from endpoint.ts; the endpoint keeps the public methods and forwards to them. Not
// re-exported by the index.
import { randomUUID } from "node:crypto";
import { AuthorizationError, PermissionViolationError, TimeoutError, type Msg, type NatsConnection, type Subscription } from "@nats-io/transport-node";
import {
  parseLivenessAnswer,
  responderFromProbe,
  isLivenessPlane,
  LIVENESS_PLANES,
  type LivenessAnswer,
  type LivenessPlane,
  type ProbeOutcome,
  type ResponderState,
} from "./liveness.js";
import { livenessServeFilter, livenessSubject } from "./subjects.js";
import type { CotalEndpoint } from "./endpoint.js";

/** What the liveness component reads from its endpoint. State is read when it is used, never
 *  copied, and every method is looked up on the endpoint at call time. */
export interface EndpointLivenessDeps {
  nc: () => NatsConnection | undefined;
  space: () => string;
  owner: () => string;
  actor: () => string;
  subs: () => Subscription[];
  livenessResponders: () => Map<LivenessPlane, { readState: () => Promise<ResponderState> | ResponderState; sub?: Subscription }>;
  notLiveMsg: () => string;
  requestBoundReply: (nc: NatsConnection, subject: string, body: string, reply: string, timeoutMs: number) => Promise<Msg>;
  isNoResponders: (e: unknown) => boolean;
  emitRecoverable: (err: Error) => void;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** One endpoint's peer-readable liveness surface: the responder it binds per plane, re-bound on
 *  every connection, and the probe that grades another responder. Internal: `CotalEndpoint` keeps
 *  the public methods and forwards to it. */
export class EndpointLiveness {
  constructor(private readonly deps: EndpointLivenessDeps) {}

  private get nc() { return this.deps.nc(); }
  private get space() { return this.deps.space(); }
  private get owner() { return this.deps.owner(); }
  private get actor() { return this.deps.actor(); }
  private get subs() { return this.deps.subs(); }
  private get livenessResponders() { return this.deps.livenessResponders(); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private requestBoundReply(nc: NatsConnection, subject: string, body: string, reply: string, timeoutMs: number) { return this.deps.requestBoundReply(nc, subject, body, reply, timeoutMs); }
  private isNoResponders(e: unknown) { return this.deps.isNoResponders(e); }
  private emitRecoverable(err: Error) { this.deps.emitRecoverable(err); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  /** Bind this endpoint as the liveness RESPONDER for one plane, answering presence and nothing
   *  else to any credentialed peer that asks (`live.<plane>.<owner>.<actor>`).
   *
   *  THE HANDLER IS THE PRIVACY BOUNDARY, and that is the entire reason this is a request/reply
   *  probe rather than a KV read grant. `readState` returns the responder's OWN verdict, derived
   *  from the lease it can already read; the LEASE ROW NEVER LEAVES THIS PROCESS. A peer therefore
   *  learns one enum about one plane and cannot learn the holder, the workspace root, the pid, the
   *  instance id, the runtime, or that any of those exist. Handing a peer the manager bucket instead
   *  would have handed it the operator's filesystem path and a pid to signal.
   *
   *  `queue`-grouped by plane, so several manager instances in one space answer a probe ONCE rather
   *  than N times. A queue group is correct here and would be wrong on a roster-style surface: the
   *  question is "is ANY responder bound", which any one member can answer.
   *
   *  THE ANSWER NAMES WHICH RESPONDER GAVE IT (`instance`), and that field exists because the queue
   *  group alone leaves a real ambiguity. Manager instances coexist per instance id by design, each
   *  member answers only about ITSELF, and the group delivers one probe to an arbitrary member. So
   *  when two instances hold opposite verdicts, identical probes alternate between them, and without
   *  a discriminator the two answers are indistinguishable from one instance changing state. With
   *  the field, a caller that probes more than once can see that two DIFFERENT responders answered
   *  and that the verdicts disagree. The field is the responder's own endpoint-scoped instance
   *  token, never the lease row's `instanceId`, its holder, its pid or its root: see
   *  {@link LivenessAnswer} for why none of those may cross the wire.
   *
   *  ONE PROBE STILL SAMPLES ONE MEMBER. This does not aggregate N instances, and a single probe
   *  cannot report a split; it makes the split OBSERVABLE to a caller that asks again, where before
   *  it was not observable at all.
   *
   *  BOUNDED REPLY, for the same confused-deputy reason `serveControl` documents: this responder
   *  holds a wildcard publish grant over `live.<plane>.*.*.reply.>`, so without the bound check an
   *  authenticated caller could name a PEER's reply lane as its reply target and have us publish
   *  into it. The broker does not permission-check a requester's embedded reply subject; we do.
   *
   *  A HANDLER THAT THROWS ANSWERS `unknown`, never silence and never health. Silence would reach
   *  the prober as a timeout, which it correctly grades `unknown` anyway — but only after burning
   *  the full deadline, and an operator staring at a hung probe learns less than one told plainly
   *  that the axis could not be checked.
   *
   *  THE BINDING IS KEPT AS INTENT and re-bound on every (re)connect, so a reconnect does not leave
   *  the plane answered by the broker's no-responders status while this endpoint is serving. A second
   *  call for the same plane replaces the first. */
  serveLiveness(plane: LivenessPlane, readState: () => Promise<ResponderState> | ResponderState): void {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const held = this.livenessResponders.get(plane);
    if (held) held.readState = readState;
    else this.livenessResponders.set(plane, { readState });
    this.bindLiveness(plane);
  }

  /** (Re)bind one plane's liveness responder on the CURRENT connection, dropping the stale sub first
   *  as {@link armDeliveryControl} does. */
  bindLiveness(plane: LivenessPlane): void {
    const held = this.livenessResponders.get(plane);
    if (!held || !this.nc) return;
    if (held.sub) {
      try { held.sub.unsubscribe(); } catch { /* dead with the old connection */ }
      const i = this.subs.indexOf(held.sub);
      if (i >= 0) this.subs.splice(i, 1);
    }
    const { readState } = held;
    const sub = this.nc.subscribe(livenessServeFilter(this.space, plane), { queue: `live.${plane}` });
    held.sub = sub;
    this.subs.push(sub);
    // The responder token this bind answers under: AN OPAQUE VALUE MINTED HERE, and deliberately
    // not any name this process already has. It is what makes "which responder answered" askable
    // without making "who is this responder" answerable — the two properties the surface has to
    // hold at once. The endpoint's own `card.id` would be its principal, the lease row's
    // `instanceId` is a field of a bucket an agent holds no grant on, and either would turn a
    // presence probe into an identity read for every credentialed peer in the space. A fresh
    // random token correlates with nothing but this plane's other answers, which is the whole job:
    // two answers carrying two different tokens came from two different responders.
    //
    // Per BIND rather than per process, so a responder that goes away and comes back answers under
    // a new token. That is the honest reading: a caller comparing answers across a restart is
    // comparing two different incarnations, and a token that survived the restart would say
    // otherwise. A re-bind after a reconnect is such a return: the plane had no responder here for
    // the gap.
    const instance = randomUUID();
    void (async () => {
      for await (const m of sub) {
        // Sender-bound reply guard. Drop silently rather than publishing somewhere else: a reply
        // aimed outside the sender's own subtree is not a request we can answer safely.
        //
        // REPORTED ON `warning`, NOT ON `error`, AND THAT IS A SAFETY PROPERTY RATHER THAN A CHOICE
        // OF CHANNEL. A rejected probe is a condition this responder is already surviving: it drops
        // the frame and keeps serving. `error` cannot carry such a notice on this class, because
        // Node's `EventEmitter` RETHROWS an `error` emit that has no listener attached, so the
        // notice would end the process of any embedder that had not attached one — and the plane
        // would then genuinely be unbound, which a peer's next probe reports as `unbound`. The
        // condition would have manufactured the state it described. `warning` is observable and
        // never fatal without a listener (see {@link emitRecoverable} and #891, where retry notices
        // on `error` killed hosts the endpoint intended to keep running).
        //
        // Since ANY credentialed peer may publish a probe, and the reply target inside it is chosen
        // by that peer and not permission-checked by the broker, reaching this branch is a peer's
        // decision, not an operator's. Safety here must therefore hold with no listener attached,
        // which is what CELL F1 runs.
        if (!m.reply || !m.reply.startsWith(`${m.subject}.reply.`)) {
          this.emitRecoverable(new Error(`rejected liveness probe on ${m.subject}: reply target "${m.reply ?? "(none)"}" is not under the sender's own reply subtree`));
          continue;
        }
        let responder: ResponderState;
        try {
          responder = await readState();
        } catch {
          responder = "unknown";
        }
        const answer: LivenessAnswer = { plane, responder, instance };
        try { m.respond(JSON.stringify(answer)); } catch { /* the requester is gone */ }
      }
      // The loop itself ends only on a SUBSCRIPTION-level fault (the connection went away), which
      // is not something a peer's probe can cause: the guard above `continue`s, `readState` is
      // caught, and the respond is caught. So this arm stays on `error` — it reports that this
      // responder has stopped answering at all, which is a fault an embedder should not be able to
      // miss, and no credentialed peer can reach it.
    })().catch((e) => this.emit("error", e as Error));
  }

  /** Ask whether a responder is bound for `plane`, as a credentialed peer that need not own it.
   *
   *  EVERY WAY THIS CAN END IS CLASSIFIED, and the classification lives in ONE place
   *  ({@link responderFromProbe}) so no call site can invent its own mapping. Only the broker's own
   *  no-responders 503 becomes `unbound`. A timeout, a permission refusal, a transport failure and
   *  an unreadable reply ALL become `unknown`, because each is a failure to find out, and this
   *  issue exists because failures to find out were being reported as findings.
   *
   *  `noMux` with a named reply subject is required rather than stylistic: the muxed inbox would
   *  swallow the 503 into an ordinary timeout, and the 503 is the only outcome that carries a
   *  positive verdict. Collapsing it would leave a probe that can say `bound` or `unknown` and
   *  never `unbound` — an instrument that cannot report the failure it was built to report.
   *
   *  The reply rides `<request>.reply.<uuid>`, the sender's own subtree, so the responder's bound
   *  reply guard accepts it and the responder needs no broad inbox-publish grant to answer. */
  async probeLiveness(plane: string, timeoutMs = 2_000): Promise<LivenessAnswer> {
    if (!isLivenessPlane(plane))
      // A closed set, refused loudly. Answering an unknown plane at all would make this a probe
      // that returns something for every input, which is indistinguishable from one that is not
      // measuring anything.
      throw new Error(`liveness: "${plane}" is not a plane this surface answers for (${[...LIVENESS_PLANES].join(", ")})`);
    if (!this.nc) throw new Error(this.notLiveMsg());
    const reqSubject = livenessSubject(this.space, plane, this.owner, this.actor);
    const reply = `${reqSubject}.reply.${randomUUID()}`;
    let outcome: ProbeOutcome;
    let answered: ResponderState | undefined;
    let instance: string | undefined;
    try {
      const m = await this.requestBoundReply(this.nc, reqSubject, "", reply, timeoutMs);
      let body: unknown;
      try { body = m.json(); } catch { body = undefined; }
      const parsed = parseLivenessAnswer(body, plane);
      // A reply we cannot read is `malformed`, which grades `unknown`. It is NOT promoted to
      // `bound` on the strength of having replied at all: that promotion is the `pgrep` error,
      // where evidence a process exists was read as evidence it works.
      outcome = parsed ? "replied" : "malformed";
      answered = parsed?.responder;
      instance = parsed?.instance;
    } catch (e) {
      outcome = this.isNoResponders(e) ? "noResponders" : this.probeFailureOutcome(e);
    }
    // `instance` rides ONLY a reply that was read. Every other outcome means no responder answered,
    // so there is no responder to name, and a token attached to an `unbound` or an `unknown` would
    // claim one had. It stays absent on those arms by construction: nothing assigns it.
    const verdict: LivenessAnswer = { plane, responder: responderFromProbe(outcome, answered) };
    return instance === undefined ? verdict : { ...verdict, instance };
  }

  /** Grade a failed probe that was NOT a no-responders answer. Both arms return an outcome that
   *  maps to `unknown`; they are told apart so the distinction stays legible at the call site and so
   *  a future caller can render the two differently (a refusal is about YOUR credential, a timeout
   *  is about something being wedged). Neither may ever mean health. */
  private probeFailureOutcome(e: unknown): ProbeOutcome {
    if (e instanceof AuthorizationError || e instanceof PermissionViolationError) return "refused";
    if (e instanceof TimeoutError) return "timeout";
    // Anything else is a transport or client failure: it says something about our link, not about
    // the plane, so it is graded like a refusal rather than guessed at.
    return "refused";
  }
}

/** The deps of one endpoint's {@link EndpointLiveness}. Every value is read from `ep` when it is used, so a field
 *  assigned after construction is seen, and a member a caller replaced on the endpoint is the one that runs. */
export function endpointLivenessDeps(ep: CotalEndpoint): EndpointLivenessDeps {
  return {
    nc: () => ep["nc"],
    space: () => ep["space"],
    owner: () => ep["owner"],
    actor: () => ep["actor"],
    subs: () => ep["subs"],
    livenessResponders: () => ep["livenessResponders"],
    notLiveMsg: () => ep["notLiveMsg"](),
    requestBoundReply: (nc, subject, body, reply, timeoutMs) => ep["requestBoundReply"](nc, subject, body, reply, timeoutMs),
    isNoResponders: (e) => ep["isNoResponders"](e),
    emitRecoverable: (err) => ep["emitRecoverable"](err),
    emit: (event, ...args) => ep["emit"](event, ...args),
  };
}
