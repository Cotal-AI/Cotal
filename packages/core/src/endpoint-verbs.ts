/**
 * v0.4 caller-side verbs (SPEC §13.5 "Verbs", §13.2 rails, §13.3 envelope) — call, cast, watch,
 * and scatter over the endpoint rails. The verb never changes the subject grammar (§13.2): a
 * call and a cast publish the same request form; the verb rides `replyExpected`, and only the
 * §13.5 gather semantics differ.
 *
 * Boundary discipline mirrors the serve side: args validate against the COMPILED input contract
 * before publish (a caller never emits a request its own contract refuses), the pinned
 * invocation digests are DERIVED from each contract's closure digest, and every consumed reply
 * or event is runtime-validated at this, its consuming boundary (§13.3) — subject-attributed
 * (instance + epoch from the SUBJECT, never the body), id-echoed, and schema-checked under the
 * same fixed §13.8 budget the responder ran. Journal-class work never rides these rails: the
 * verbs pin `class: "ephemeral"`; submissions go through the `epj` journal machinery (§13.4).
 */
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { spacePrefix } from "./subjects.js";
import { parseEpSubject, assertLifecycleToken } from "./endpoint-subjects.js";
import { EpEnvelopeError, registryReadFailed, parseEndpointEvent, type EndpointEvent } from "./endpoint-envelope.js";
import type { JetStreamManager } from "@nats-io/jetstream";
import { freezeExpectedSet, registrationReconciler, serviceEpochReader, type FrozenInstance } from "./endpoint-service.js";
import { type EpAttributedReply, type EpInstanceLiveness, type EpVerbOp, assertDeadline, buildRequest, epCall, parseAttributedReply, raceBounded, registryReadDetail, replySubjectFor } from "./endpoint-call.js";
export { epCall, epCast, epProbeInstanceInterest } from "./endpoint-call.js";
export type { EpAttributedReply, EpInstanceLiveness, EpVerbOp, EpVerbTarget } from "./endpoint-call.js";

// ---- watch: the LIVE-EVENT half (§13.5) --------------------------------------------------------
//
// The §13.5 `watch` verb has two forms, and this file owns only the live-event one:
//   - a RECORD watch (KV watch; fell-behind ⇒ re-read, §13.4) IS {@link import("./endpoint-records.js").watchRecord};
//   - an EVENT topic watch = a live subscription within the read grant (below) PLUS filtered replay
//     from the event stream, which is the §13.9 MEDIATED read (a durable catch-up onto the caller's
//     own rail), not a raw JetStream tap here.
// `epWatchEvents` is therefore named for exactly what it is — the live event tap — so it is not read
// as the whole `watch` verb. Composing the mediated replay with this live tail is a later slice.

/** One attributed event: identity and epoch come from the SUBJECT (§13.2: forge-locked tokens;
 *  a stale-epoch event is attributably stale — surfaced, never hidden). */
export interface EpAttributedEvent {
  endpoint: string;
  instanceId: string;
  epoch: number;
  topic: string[];
  event: EndpointEvent;
}

export interface EpWatchHandle {
  stop(): Promise<void>;
}

/**
 * Watch a granted `epe` subtree LIVE (the event half of §13.5 `watch`; §13.9: the read grant is the
 * caller's own `sub.allow` row, e.g. the per-goal progress subtree — delivery lands only on this
 * caller's own subscription). Every event is validated at this consuming boundary: an unparseable
 * subject or body is reported through `onError` (§13.3: fail loud, never a silent drop) and never
 * reaches `onEvent`. This is the LIVE tap ONLY — durable catch-up / filtered replay is the §13.9
 * mediated read (see the module note above), and record watch is `watchRecord` (§13.4).
 */
export function epWatchEvents(
  nc: NatsConnection,
  space: string,
  filter: string,
  handlers: { onEvent: (ev: EpAttributedEvent) => void; onError: (err: EpEnvelopeError) => void },
): EpWatchHandle {
  if (!filter.startsWith(`${spacePrefix(space)}.epe.`))
    throw new Error(`epWatchEvents filter "${filter}" is not an epe subtree of space "${space}" (SPEC 13.9: watch reads the event plane)`);
  const sub = nc.subscribe(filter, {
    callback: (err, msg) => {
      if (err) {
        handlers.onError(new EpEnvelopeError("unavailable", `the watch subscription failed: ${err.message}`));
        return;
      }
      const parsed = parseEpSubject(msg.subject);
      if (!parsed || parsed.plane !== "event") {
        handlers.onError(new EpEnvelopeError("internal", `a message on the watch filter does not parse as an event subject: ${msg.subject}`));
        return;
      }
      let event: EndpointEvent;
      try {
        event = parseEndpointEvent(JSON.parse(new TextDecoder().decode(msg.data)));
      } catch (e) {
        handlers.onError(e instanceof EpEnvelopeError ? e : new EpEnvelopeError("internal", `event body does not decode: ${(e as Error).message}`));
        return;
      }
      handlers.onEvent({ endpoint: parsed.endpoint, instanceId: parsed.instanceId, epoch: parsed.epoch, topic: parsed.topic, event });
    },
  });
  return { stop: () => sub.drain() };
}

// ---- scatter (§13.5: frozen expected set, attributed gather) ------------------------------------

/** The scatter gathers against a request-scoped FROZEN expected set (§13.5): the live instances of
 *  the class, each `(instanceId, registrationRevision, epoch)` at send time. This is exactly
 *  {@link import("./endpoint-service.js").freezeExpectedSet}'s output — pass it through so the freeze
 *  identity (all THREE coordinates, not just instance+epoch) is what the gather classifies against. */
export type EpScatterSlot = FrozenInstance;

/** Why a frozen slot's reply is churn (§13.5): `epoch` — it replied at a DIFFERENT process epoch than
 *  frozen (a takeover restarted it); `registration` — its `svc….spec` registrationRevision advanced
 *  past the frozen value (a re-registration re-declared its surface). Both mean the reply may be from
 *  an incarnation that never saw this request, so it does NOT count toward completion. Registration
 *  churn is NOT visible on the reply rail (the reply subject carries epoch, not registrationRevision,
 *  and a re-registration does not advance the epoch), so it is observed only when a registration
 *  reconcile runs (see {@link epScatter} `reconcileRegistration`). */
export type EpChurnReason = "epoch" | "registration";

/** The §13.5 scatter outcome. `complete` means EXPECTED-SLOT COVERAGE — every frozen slot produced
 *  exactly one counted valid reply at its frozen `(epoch, registrationRevision)`, verified against the
 *  registration reconcile — NOT that the gather was anomaly-free. `missing` and `invalid` force
 *  `complete` false; a `registration`-churn drops a slot's counted reply (so that slot becomes
 *  uncovered → false). But `duplicate`, `unexpected`, and an `epoch`-churn reply do NOT by themselves
 *  force false: a slot that answered validly at its frozen epoch stays counted even if a stray
 *  different-epoch reply from another incarnation also arrived. First valid reply per frozen
 *  `(instanceId, epoch)` wins. */
export interface EpScatterResult {
  complete: boolean;
  /** instanceId → the first VALID attributed reply from that frozen slot at its frozen epoch. */
  replies: Map<string, EpAttributedReply>;
  /** Frozen slots with NO reply of any kind by the DEADLINE (the classification point). A slot that
   *  produced only churn/duplicate/invalid is reported there. A slot that produced ONLY a `late` reply
   *  is BOTH `missing` (no on-time reply) and `late` (observational): classification linearizes at the
   *  deadline, and the drain enriches, never moves it. */
  missing: string[];
  /** Replies from a DIFFERENT endpoint, or from an instance OUTSIDE the frozen set. Never count. */
  unexpected: { instanceId: string; epoch: number }[];
  /** Frozen slots whose reply came from a superseded incarnation — a DIFFERENT epoch, or (via the
   *  mandatory `reconcileRegistration`) an advanced registrationRevision. Does NOT count. */
  churn: { instanceId: string; epoch: number; reason: EpChurnReason }[];
  /** Second-and-later replies from a frozen `(instanceId, epoch)` after its first classified one:
   *  REPORTED, never silently dropped (§13.5); first reply wins, whatever it was classified. */
  duplicate: { instanceId: string; epoch: number }[];
  /** Valid frozen-slot replies observed AFTER the deadline, during the optional bounded `lateDrainMs`
   *  window: too late to count, reported not dropped. Empty unless `lateDrainMs` set. */
  late: { instanceId: string; epoch: number }[];
  /** Frozen-slot replies that failed this consuming boundary (unparseable body, id mismatch, invalid
   *  success payload, mis-attributed). NON-TERMINAL: an invalid frame does NOT consume the slot's one
   *  terminal reply — the slot stays open to a later valid reply, bounded by the deadline. But any
   *  recorded invalid keeps `complete` false (§13.3 fail-loud: an observed anomaly is not clean).
   *  Not a §13.5-enumerated bucket; kept because fail-loud forbids counting an invalid reply as valid. */
  invalid: { instanceId: string; epoch: number; message: string }[];
}

/** The reconcile hook's per-instance verdict. An instance STILL in the registry carries its current
 *  `registrationRevision`; one the mediated §13.9 read observed as GONE is `{ registered: false }`.
 *  This is an EXPLICIT value, distinct from an absent Map entry — an absent entry stays an incomplete
 *  read (`failed-precondition`), so a buggy/partial hook can never masquerade as "everyone deregistered".
 *  A mid-scatter deregistration is NOT registration-churn (a re-registration advances the revision and
 *  invalidates the reply; a plain departure does not): a valid reply the instance already gave still
 *  counts, and if it never replied its slot falls to `missing`. */
export type EpRegistrationState =
  | { registered: true; registrationRevision: number }
  | { registered: false };

/**
 * Scatter one command to a FROZEN expected set (§13.5): publish once on the `all` rail, gather
 * attributed replies on the caller's nonce-scoped rail, and CLASSIFY against the freeze. An empty set
 * refuses (`failed-precondition`, never an empty success), and the observation channel is fail-loud:
 * a failed reply subscription is `unavailable`, never fabricated member silence.
 *
 * CLASSIFICATION LINEARIZES AT THE GATHER DEADLINE. The classification point T is `min(all frozen
 * slots answered-valid, deadline)`; `missing` is fixed at T (from the `respondedAtDeadline` snapshot).
 * The `lateDrainMs` window runs AFTER T on an ABSOLUTE clock — the rail is closed exactly `lateDrainMs`
 * after T regardless of how long the reconcile takes, so late classification cannot leak past the
 * requested horizon. It is OBSERVATIONAL only: it may add to `late`/`duplicate`, never move
 * `missing`/`churn`/`complete`. With `lateDrainMs` omitted the rail closes at T (no `late`).
 *
 * WHOLE-OPERATION BUDGET. The op is bounded: the gather to T comes FIRST, then a post-T phase in which
 * the reconcile and the drain run CONCURRENTLY (the drain is armed at T, before the reconcile await).
 * So worst-case wall-clock ≈ `deadlineMs` (gather) + `max(reconcileDeadlineMs, lateDrainMs)` (post-T),
 * NOT their sum. The reconcile is a bounded read taken SHORTLY AFTER T (not a zero-width at-T snapshot):
 * a true instant-of-T revision would need a watch/frontier, so a re-registration strictly concurrent
 * with the bounded read is an inherent, documented window (recorded for the §13.5 SPEC reconciliation).
 *
 * Two §13.5 signals are not on the reply rail, so the caller supplies them as HOOKS (keeping the verb
 * free of storage coupling; the §13.9 read grant stays with the caller, and a caller-read revision is
 * more trustworthy than a responder-stamped one):
 *  - `reconcileRegistration` (REQUIRED): reads EVERY frozen slot's CURRENT state after the classification
 *    point, returning a per-instance `EpRegistrationState` verdict. A slot still registered at a revision
 *    ADVANCED past its frozen one is `churn` ("registration") and uncounted (a re-registration advances
 *    registrationRevision WITHOUT advancing the epoch, so the reply rail cannot see it). A slot the read
 *    observed as GONE (`{ registered: false }`) is an explicit mid-scatter deregistration: NOT churn, and
 *    a valid reply it already gave still counts (a plain departure does not invalidate the reply the way
 *    a re-registration would). Its result is COMPLETENESS-validated: a frozen id ABSENT from the returned
 *    Map is an incomplete read (`failed-precondition`) — distinct from an explicit `{ registered: false }`
 *    verdict — a non-integer/non-positive revision is a garbled read (`failed-precondition`), and a
 *    revision BELOW the frozen one is a non-monotonic/buggy read (`failed-precondition`); otherwise a
 *    partial hook would silently preserve the old full-triple over-claim. It is BOUNDED by
 *    `reconcileDeadlineMs`: a never-settling read is `unavailable`, never a hung scatter (SPEC 13.5:
 *    deadline mandatory); an unreadable registry is `failed-precondition`. Authoritative `complete`
 *    requires it.
 *  - `reconcileDeadlineMs` (optional, default `deadlineMs`): the explicit bound on that post-T read,
 *    named so the single `deadlineMs` is not silently spent twice.
 *  - `lateDrainMs` (optional): the absolute post-T horizon for `late` classification. Omitted → none.
 *  - `probeLiveness` (optional): affirmative per-instance liveness, run concurrently with the gather.
 *    The gather's only exits are "every frozen slot answered" and the deadline, so a slot that CANNOT
 *    answer makes the first unreachable and the deadline is paid in full — every scatter in the space,
 *    forever, because the registry has no expiry and a crashed instance never deregisters. This hook
 *    supplies the missing fact. It moves the classification point T EARLIER and moves NOTHING else:
 *    a slot the broker affirms is gone is still `missing`, still surfaced, still not `complete`.
 *    ONLY the verdict `gone` licenses anything; `live`, `unknown`, a throwing hook, and any value
 *    outside the closed set all license nothing and leave the full deadline standing. That asymmetry
 *    is deliberate and is the safety argument: a broken or lying-quiet probe degrades to exactly
 *    today's behavior, never to a fast wrong answer.
 */
export async function epScatter(
  nc: NatsConnection,
  space: string,
  op: EpVerbOp,
  opts: {
    deadlineMs: number;
    expected: EpScatterSlot[];
    reconcileRegistration: () => Promise<Map<string, EpRegistrationState>>;
    reconcileDeadlineMs?: number;
    lateDrainMs?: number;
    probeLiveness?: (instanceId: string) => Promise<EpInstanceLiveness>;
  },
): Promise<EpScatterResult> {
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const reconcileDeadlineMs = opts.reconcileDeadlineMs !== undefined ? assertDeadline(opts.reconcileDeadlineMs, "reconcileDeadlineMs") : deadlineMs;
  const lateDrainMs = opts.lateDrainMs !== undefined ? assertDeadline(opts.lateDrainMs, "lateDrainMs") : 0;
  if (opts.expected.length === 0)
    throw new EpEnvelopeError("failed-precondition", "scatter requires a non-empty frozen expected set (SPEC 13.5: an empty registry is never an empty success)");
  const frozen = new Map<string, { epoch: number; registrationRevision: number }>();
  for (const slot of opts.expected) {
    const iId = assertLifecycleToken(slot.instanceId, "instanceId");
    // Validate the frozen (epoch, registrationRevision) coordinates at this public ingress: an untyped
    // adapter that handed in a NaN/float/negative would otherwise slip past the currency and
    // monotonicity fences downstream (a NaN compares false both ways). Epoch is a non-negative safe
    // integer (the subject epoch), registrationRevision a positive safe integer (a KV revision, §13.7).
    if (!Number.isSafeInteger(slot.epoch) || slot.epoch < 0)
      throw new EpEnvelopeError("bad-request", `frozen instance ${iId} has a non-integer/negative epoch ${slot.epoch}; a frozen coordinate must be a safe integer so an untyped adapter cannot disable the currency fence (§13.2)`);
    if (!Number.isSafeInteger(slot.registrationRevision) || slot.registrationRevision <= 0)
      throw new EpEnvelopeError("bad-request", `frozen instance ${iId} has a non-integer/non-positive registrationRevision ${slot.registrationRevision}; a frozen coordinate must be a positive safe integer so an untyped adapter cannot disable the monotonicity fence (§13.7)`);
    if (frozen.has(iId))
      throw new EpEnvelopeError("failed-precondition", `the frozen expected set names instance ${iId} twice`);
    frozen.set(iId, { epoch: slot.epoch, registrationRevision: slot.registrationRevision });
  }

  const req = buildRequest(space, { mode: "all" }, op, { replyExpected: true, deadlineMs });
  const result: EpScatterResult = { complete: false, replies: new Map(), missing: [], unexpected: [], churn: [], duplicate: [], late: [], invalid: [] };
  const terminal = new Set<string>();  // frozen slots with a VALID frozen-epoch reply (drives early completion)
  const seen = new Set<string>();      // "(instanceId,epoch)" pairs already classified non-invalid (drives §13.5 duplicate)
  const responded = new Set<string>(); // frozen slots that produced ANY reply (live)
  const gone = new Set<string>();      // frozen slots the BROKER affirmed hold no subscription
  const regChurned = new Set<string>();
  const failMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let respondedAtDeadline: Set<string> | undefined; // `responded` snapshotted at the classification point
  let deadlinePassed = false;
  let subError: unknown;

  // Classify one reply; returns true when every frozen slot has a VALID reply (early completion).
  const handle = (subject: string, data: Uint8Array): boolean => {
    const parsed = parseEpSubject(subject);
    if (!parsed || parsed.plane !== "reply") return false; // not a reply subject: no sender, MUST NOT be handled (§13.2)
    const { instanceId, epoch } = parsed;
    // §13.2 endpoint binding BEFORE slot matching: instanceIds are unique only within (space,
    // endpoint), so a truthfully-attributed reply from a DIFFERENT endpoint with a colliding
    // (instanceId, epoch) must never satisfy a frozen slot.
    if (parsed.endpoint !== op.endpoint) { result.unexpected.push({ instanceId, epoch }); return false; }
    const slot = frozen.get(instanceId);
    if (slot === undefined) { result.unexpected.push({ instanceId, epoch }); return false; }
    responded.add(instanceId);
    const key = `${instanceId}:${epoch}`;
    // §13.5 duplicate: a second reply from the SAME (instanceId, epoch) after its first NON-INVALID
    // classification (valid | churn-epoch | late) — reported, first wins. An invalid frame never marks
    // the coordinate seen, so a later valid frame from it is NOT mislabeled duplicate.
    if (seen.has(key)) { result.duplicate.push({ instanceId, epoch }); return false; }
    if (epoch !== slot.epoch) { result.churn.push({ instanceId, epoch, reason: "epoch" }); seen.add(key); return false; }
    if (deadlinePassed) {
      // Post-deadline, frozen epoch: a first VALID reply is LATE (observational, uncounted); a boundary
      // failure is `invalid` (NON-terminal — the coordinate stays un-seen).
      try { parseAttributedReply(space, subject, data, req.requestId, op); result.late.push({ instanceId, epoch }); seen.add(key); }
      catch (e) { result.invalid.push({ instanceId, epoch, message: failMsg(e) }); }
      return false;
    }
    // Pre-deadline, frozen epoch. An invalid frame is NON-TERMINAL: reported, the slot stays open to a
    // later valid reply, the coordinate stays un-seen, and it never triggers early completion.
    try { result.replies.set(instanceId, parseAttributedReply(space, subject, data, req.requestId, op)); }
    catch (e) { result.invalid.push({ instanceId, epoch, message: failMsg(e) }); return false; }
    terminal.add(instanceId); seen.add(key);
    return terminal.size === frozen.size;
  };

  // NOTHING outstanding can still answer: every frozen slot has either produced a valid reply or been
  // affirmed gone by the broker. Checked on BOTH events that can make it true — a verdict landing and
  // a reply landing — because the last thing to settle is as often the live peer's slow answer as it
  // is the corpse's verdict, and a check that ran only on verdicts would leave the common case (one
  // corpse affirmed immediately, one live instance answering a second later) paying the full deadline.
  const settled = (): boolean => {
    for (const id of frozen.keys()) if (!terminal.has(id) && !gone.has(id)) return false;
    return true;
  };

  let sub: Subscription | undefined;
  // Phase 1 — gather to the classification point T = min(all-valid, all-accounted-for, deadline). NO
  // drain here; the drain is a later observational phase so it can never move the classification.
  await new Promise<void>((resolve) => {
    let ended = false;
    const finishAtT = () => { if (respondedAtDeadline === undefined) respondedAtDeadline = new Set(responded); };
    // `incomplete` marks the two exits at which some frozen slot did NOT answer, so the post-T rail
    // stays open for a straggler and classifies it `late` rather than dropping it. Early completion
    // (every slot answered) is not one of them: there is nothing left to be late.
    const finish = (incomplete: boolean) => {
      if (ended) return;
      ended = true;
      if (incomplete) deadlinePassed = true;
      finishAtT(); clearTimeout(timer); resolve();
    };
    const timer = setTimeout(() => finish(true), deadlineMs);
    sub = nc.subscribe(replySubjectFor(space, op.caller, req.n), {
      callback: (err, msg) => {
        if (err) { subError ??= err; finish(false); return; } // fail loud, never fake `missing`
        if (handle(msg.subject, msg.data)) finish(false); // every slot answered: complete, nothing can be late
        else if (settled()) finish(true);                 // the rest are affirmed gone: T is now
      },
    });
    nc.publish(req.subject, req.body);
    // AFFIRMATIVE liveness, concurrent with the gather and never gating it. A verdict can only end
    // the gather EARLY; it can never extend it, and a probe still in flight at the deadline is
    // simply irrelevant by then.
    if (opts.probeLiveness !== undefined)
      for (const instanceId of frozen.keys())
        void (async () => {
          let verdict: EpInstanceLiveness;
          // A probe that FAILED established nothing. Same rule as the verdicts below and for the
          // same reason: only `gone` is evidence, everything else leaves the deadline standing.
          try { verdict = await opts.probeLiveness!(instanceId); } catch { return; }
          if (verdict !== "gone" || ended) return;
          gone.add(instanceId);
          if (settled()) finish(true); // one corpse among live peers still waits for them

        })();
  });

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (subError !== undefined)
      throw new EpEnvelopeError("unavailable", `the scatter reply subscription failed; without a working observation channel member silence cannot be classified, never fabricated (SPEC 13.5): ${failMsg(subError)}`);

    // The late window is an ABSOLUTE horizon from T: close the rail exactly `lateDrainMs` after T
    // (early completion has no window), independent of how long the reconcile below runs — so a reply
    // during a slow reconcile is NOT misclassified `late`, and with no `lateDrainMs` the rail closes
    // now. Runs concurrently with the reconcile.
    const drainMs = deadlinePassed ? lateDrainMs : 0;
    const drainDone = new Promise<void>((resolve) => {
      if (drainMs > 0) drainTimer = setTimeout(() => { sub?.unsubscribe(); resolve(); }, drainMs);
      else { sub?.unsubscribe(); resolve(); }
    });

    // Reconcile shortly after T, bounded by its OWN explicit budget (not a second full `deadlineMs`):
    // a never-settling read is `unavailable`, an unreadable registry `failed-precondition`. Only the
    // bound's own MARKED refusal passes through as is: the hook is untrusted caller-supplied code,
    // so whatever it throws is the read failing and is normalized and marked here. Keying the
    // pass-through on the code instead would let a hook's bare `unavailable` escape unmarked, and an
    // unmarked refusal is what a consumer cannot classify.
    let current: Map<string, EpRegistrationState>;
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      current = await Promise.race([
        opts.reconcileRegistration(),
        new Promise<never>((_, reject) => { reconcileTimer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `the scatter registration reconcile did not settle within its ${reconcileDeadlineMs}ms bound (SPEC 13.5: deadline mandatory, never a hung scatter)`, [registryReadDetail(op)])), reconcileDeadlineMs); }),
      ]);
    } catch (e) {
      if (registryReadFailed(e)) throw e; // the reconcile bound above
      throw new EpEnvelopeError("failed-precondition", `the scatter registration reconcile is unreadable; an unreadable registry is failed-precondition, never an empty success (SPEC 13.5): ${failMsg(e)}`, [registryReadDetail(op)]);
    } finally {
      if (reconcileTimer !== undefined) clearTimeout(reconcileTimer);
    }
    // COMPLETENESS + MONOTONICITY: the mandatory reconcile must return an EXPLICIT verdict for every
    // frozen slot, else a partial/buggy read would silently preserve the old full-triple over-claim.
    // An ABSENT Map entry is an incomplete read (fail-loud) — distinct from an explicit deregistration
    // verdict. A still-registered slot's revision below-frozen is non-monotonic (revisions only advance
    // on mediated registration writes, §13.7), a NaN/non-integer one is garbled: both fail-loud. An
    // advanced revision is registration-churn (drops the counted reply). An explicit deregistration is
    // NOT churn: a valid reply the instance already gave still counts, and if it never replied its slot
    // falls to `missing` below.
    for (const [instanceId, slot] of frozen) {
      const state = current.get(instanceId);
      if (state === undefined)
        throw new EpEnvelopeError("failed-precondition", `the reconcile returned no verdict for frozen instance ${instanceId}; an incomplete registration read cannot authorize completion, and an absent Map entry is NOT an implicit deregistration (SPEC 13.5)`);
      // RUNTIME-validate the discriminant at this untrusted boundary (TS alone cannot fence a
      // caller-supplied/legacy hook): the verdict MUST be an explicit `{ registered: boolean }`. A bare
      // number, `{}`, or `{ registered: 0 }` must FAIL LOUD, never fall through the falsy check below as
      // an implicit deregistration and bypass the completeness fence the typed result exists to enforce.
      if (typeof state !== "object" || state === null || typeof (state as { registered?: unknown }).registered !== "boolean")
        throw new EpEnvelopeError("failed-precondition", `the reconcile verdict for instance ${instanceId} is not a typed { registered: boolean } state; an untyped/legacy value must never masquerade as a deregistration (SPEC 13.5)`);
      if (state.registered === false) continue; // explicit mid-scatter deregistration: not churn; a prior reply still counts
      const now = state.registrationRevision;
      if (!Number.isSafeInteger(now) || now <= 0)
        throw new EpEnvelopeError("failed-precondition", `the reconcile reports instance ${instanceId} at a non-integer/non-positive registrationRevision ${now}; a NaN or garbled value is neither below nor above the frozen revision and would silently disable the monotonicity fence (§13.7), so it is refused, never a counted completion`);
      if (now < slot.registrationRevision)
        throw new EpEnvelopeError("failed-precondition", `the reconcile reports instance ${instanceId} at registrationRevision ${now}, below its frozen ${slot.registrationRevision}; registration revisions are monotonic (§13.7), so a lower value is a buggy/unreadable read`);
      if (now > slot.registrationRevision) {
        result.replies.delete(instanceId);
        result.churn.push({ instanceId, epoch: slot.epoch, reason: "registration" });
        regChurned.add(instanceId);
      }
    }

    await drainDone; // let the absolute late window fully elapse (observational) before finalizing
  } finally {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    sub?.unsubscribe();
  }

  const respondedT = respondedAtDeadline ?? responded;
  for (const instanceId of frozen.keys())
    if (!respondedT.has(instanceId) && !regChurned.has(instanceId)) result.missing.push(instanceId);
  // Coverage completion: every frozen slot has a counted valid reply, none reg-churned (drops
  // replies.size), no missing, and NO observed invalid frame (fail-loud: an invalid is not clean).
  result.complete = result.missing.length === 0 && result.invalid.length === 0 && result.replies.size === frozen.size;
  return result;
}

// ---- the registry-wired caller entry points (§13.5) ---------------------------------------------

/**
 * Scatter one command to the LIVE class (§13.5), registry-wired end to end: freeze the expected
 * set from the service registry, publish once on the `all` rail, and reconcile registration
 * currency post-T — the full §13.5 sequence behind one call. `jsm` drives the LEADER-served
 * coordinate reads (the freeze's per-slot spec/status and the reconcile), `kv` the bounded-lag
 * instance enumeration; every freeze/reconcile refusal (`failed-precondition` on an empty or
 * unreadable registry, `internal` on malformed mediated-writer state) and every gather
 * classification passes through unchanged. The hooks stay public: a caller composing its own
 * freeze (a pinned set, a test harness) uses {@link epScatter} directly.
 */
export async function epScatterService(
  nc: NatsConnection,
  jsm: JetStreamManager,
  space: string,
  op: EpVerbOp,
  opts: {
    deadlineMs: number; reconcileDeadlineMs?: number; lateDrainMs?: number;
    /** The §13.5 liveness hook, FORWARDED from the caller and never invented here.
     *
     *  This function knows the frozen set only AFTER the freeze, so an auto-probe built in here
     *  would publish on instance rails the caller may hold no grant for, and a refused publish is
     *  invisible to it: the broker's violation lands on the CONNECTION, the probe just times out,
     *  and the operation reports `unknown` — the exact "slow" reading of a permission bug this
     *  whole change exists to stop. The caller is the only layer that knows which rails its
     *  credential carries, so the caller supplies the closure (and, with it, its own budget and its
     *  own violation reporting). Omitted ⇒ no probe, and the gather is bit-for-bit the pre-#468
     *  deadline behaviour.
     *
     *  {@link epProbeInstanceInterest} is the ready-made implementation; a caller pins it to its
     *  own grant set. */
    probeLiveness?: (instanceId: string) => Promise<EpInstanceLiveness>;
  },
): Promise<EpScatterResult> {
  // ONE ABSOLUTE deadline covers the whole op (distsys BLOCKING 2): the freeze (STREAM.INFO
  // enumeration + per-slot leader reads) is charged against `deadlineMs`, not run unbounded before
  // it. A freeze that never settles is `deadline-exceeded`, never a scatter that silently overruns
  // its budget, and the gather runs on the REMAINING budget.
  const deadlineMs = assertDeadline(opts.deadlineMs);
  const started = Date.now();
  const expected = await raceBounded(() => freezeExpectedSet(jsm, space, op.endpoint), deadlineMs, `the scatter freeze for ${op.endpoint}`, [registryReadDetail(op)]);
  const remaining = deadlineMs - (Date.now() - started);
  if (remaining <= 0)
    throw new EpEnvelopeError("deadline-exceeded", `the scatter freeze for ${op.endpoint} consumed the whole ${deadlineMs}ms budget; no time left to gather (SPEC 13.5)`, [registryReadDetail(op)]);
  return epScatter(nc, space, op, {
    ...opts, deadlineMs: remaining, expected,
    reconcileRegistration: registrationReconciler(jsm, space, op.endpoint, expected),
  });
}

/**
 * Call one command with the registry-wired currency check (§13.2): on the `one` rail the queue
 * winner's epoch is verified against a LEADER-served read of its `svc….status` through
 * {@link serviceEpochReader}; the `inst` rail pins its incarnation up front and needs no read, so
 * the hook is not wired there. Every {@link epCall} refusal passes through unchanged (a superseded
 * winner is `expired`; an unregistered or never-converged responder is the read's own
 * `failed-precondition`, never mislabeled staleness).
 */
export async function epCallService(
  nc: NatsConnection,
  jsm: JetStreamManager,
  space: string,
  route: { mode: "one" } | { mode: "inst"; instanceId: string; epoch: number },
  op: EpVerbOp,
  opts: { deadlineMs: number },
): Promise<EpAttributedReply> {
  return epCall(nc, space, route, op, route.mode === "one" ? { ...opts, currentEpoch: serviceEpochReader(jsm, space, op.endpoint) } : opts);
}
