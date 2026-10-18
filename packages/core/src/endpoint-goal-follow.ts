/** The node-free goal follow (SPEC 13.6): submit, then follow the goal to its terminal on the
 *  caller's own progress subject, shared by `endpoint-invoke` and the browser entry. Moved from
 *  `endpoint-invoke.ts`; the host supplies how a goal-result fact is verified. */
import { PermissionViolationError, type NatsConnection, type Subscription } from "@nats-io/nats-core";
import { EpEnvelopeError, renderLifecycleBlocked, lifecycleBlockedFrom, unansweredRequest } from "./endpoint-envelope.js";
import type { GoalResultFact, GoalRef } from "./endpoint-action.js";
import type { EpAttributedReply } from "./endpoint-call.js";
import { epGoalProgressGrantRow } from "./endpoint-goal-subjects.js";
import type { EpCaller } from "./endpoint-subjects.js";
import { GOAL_FOLLOW_MARGIN_MS, dec } from "./endpoint-caller.js";

export interface SubmitAndFollowGoalOptions {
  /** Read through the current authorized transport. Cancellation owns this read, not the goal. */
  reconcile?: (goalId: string, attributed: EpAttributedReply, context: {
    caller: EpCaller; signal: AbortSignal; deadlineMs: number;
  }) => Promise<{ goalId: string; result?: GoalResultFact } | undefined>;
  currentNc?: () => NatsConnection | undefined;
  onReconnect?: (handler: (newNc: NatsConnection) => void) => () => void;
  signal?: AbortSignal;
  /** Work that must finish before the submission and cannot itself carry out the command, such as
   *  resolving the endpoint. It is given the follow's deadline as an epoch-ms time to spend, and its
   *  failures surface unchanged. At the deadline its signal aborts with a `TimeoutError`, and only a
   *  describe that drew no reply keeps its own error then. A stop, or the deadline otherwise, reports
   *  `not-executed`. */
  prepare?: (signal: AbortSignal, deadline: number) => Promise<void>;
}

/** How a host verifies a goal-result fact: the root's synchronous `parseGoalResultFact`, or the browser
 *  entry's Web Crypto equivalent. Both run the same closed shape checks and the outcome digest check. */
export type GoalResultFactVerifier = (raw: unknown, subject: string, ref: GoalRef) => GoalResultFact | Promise<GoalResultFact>;

/** Subscribe before a single submission, then observe its accepted goal through live progress and
 *  mediated canonical reads. Local failures before an attributed reply throw; they never invent a
 *  responder. Once accepted, observation failures retain that responder and never authorize retry.
 *  A terminal other than `succeeded` keeps the acceptance as its data, so the caller still holds the
 *  allocated identity of a goal that settled `uncertain` and may yet converge. */
export async function submitAndFollowGoalWith(
  verifyFact: GoalResultFactVerifier,
  nc: NatsConnection,
  space: string,
  endpoint: string,
  caller: EpCaller,
  deadlineMs: number,
  submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
  opts?: SubmitAndFollowGoalOptions,
): Promise<EpAttributedReply> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)
    throw new EpEnvelopeError("bad-request", "goal following requires a positive integer deadline", undefined, "not-executed");
  const acceptingCaller = { ...caller };
  const terminals = new Map<string, { state: string; data?: unknown }>();
  const progressSubject = epGoalProgressGrantRow(space, endpoint, acceptingCaller);
  const work = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let activeNc = nc;
  let activeSub: Subscription | undefined;
  let generation = 0;
  let unbindReconnect: (() => void) | undefined;
  let completed = false;
  let stopped = opts?.signal?.aborted === true;
  let submitted = false;
  let subError: Error | undefined;
  let observationError: Error | undefined;
  let wake: (() => void) | undefined;
  let abortPhase: (() => void) | undefined;
  let needsReconcile = false;
  let reading = false;
  let progressReady = false;
  const aborted = new Promise<void>((resolve) => { abortPhase = resolve; });
  const onAbort = () => {
    stopped = true;
    work.abort();
    abortPhase?.();
    wake?.();
  };
  const phaseError = (code: "unavailable" | "deadline-exceeded") => new EpEnvelopeError(code,
    submitted
      ? "the goal submission was interrupted while in flight; its outcome is unknown. It may have been accepted or executed; do NOT retry without inspecting 'ps'/'inspect' first (SPEC 13.6)"
      : "goal observation stopped or exceeded its deadline before submission; the manager request WAS NOT RUN",
    undefined, submitted ? "unknown" : "not-executed");
  let deadline = Date.now() + deadlineMs;
  const bounded = async <T>(operation: () => Promise<T>, until: number): Promise<T> => {
    if (stopped || completed) throw phaseError("unavailable");
    const remaining = until - Date.now();
    if (remaining <= 0) throw phaseError("deadline-exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        aborted.then(() => { throw phaseError("unavailable"); }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(phaseError("deadline-exceeded")), Math.min(remaining, 2_147_483_647));
          timers.add(timer);
        }),
      ]);
    } finally {
      if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); }
    }
  };
  const subscribe = (next: NatsConnection) => {
    if (completed || stopped) return;
    const mine = ++generation;
    activeSub?.unsubscribe();
    activeNc = next;
    progressReady = false;
    subError = undefined;
    activeSub = next.subscribe(progressSubject, {
      callback: (err, msg) => {
        if (completed || stopped || mine !== generation) return;
        if (err) { subError ??= err; wake?.(); return; }
        let ev: { goalId?: unknown; phase?: unknown; state?: unknown; data?: unknown };
        try { ev = JSON.parse(dec.decode(msg.data)); } catch { return; }
        if (ev?.phase === "terminal" && typeof ev.goalId === "string") {
          terminals.set(ev.goalId, { state: String(ev.state), data: ev.data });
          wake?.();
        }
      },
    });
  };
  const replaceConnection = (next: NatsConnection) => {
    if (completed || stopped) return;
    try { subscribe(next); }
    catch (err) { subError = err instanceof Error ? err : new Error(String(err)); wake?.(); return; }
    const mine = generation;
    void bounded(() => next.flush(), deadline).then(() => {
      if (completed || stopped || mine !== generation) return;
      progressReady = true;
      needsReconcile = true;
      wake?.();
    }, (err) => {
      if (completed || stopped || mine !== generation) return;
      subError = err instanceof Error ? err : new Error(String(err));
      wake?.();
    });
  };
  try {
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    if (stopped) throw phaseError("unavailable");
    if (opts?.prepare) {
      // The deadline first aborts the prepare's signal, so a describe the prepare started after other
      // steps reports that it drew no reply. A prepare that ignores its signal is cut off a turn later.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([opts.prepare(work.signal, deadline), aborted, new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            work.abort(new DOMException("the goal follow's deadline passed", "TimeoutError"));
            // A macrotask after the abort settles; a browser has no setImmediate.
            if (typeof setImmediate === "function") setImmediate(resolve); else setTimeout(resolve, 0);
          }, Math.min(deadline - Date.now(), 2_147_483_647));
        })]);
        work.signal.throwIfAborted();
      } catch (err) {
        throw stopped ? phaseError("unavailable") : work.signal.aborted && !unansweredRequest(err) ? phaseError("deadline-exceeded") : err;
      } finally {
        clearTimeout(timer);
      }
    }
    subscribe(opts?.currentNc?.() ?? nc);
    unbindReconnect = opts?.onReconnect?.(replaceConnection);
    // A borrowed submit can publish on another connection. Confirm broker interest first,
    // including a replacement that arrived while the first connection's flush was pending.
    for (;;) {
      const preparing = activeNc;
      try { await bounded(() => preparing.flush(), deadline); }
      catch (err) { if (!stopped && preparing !== activeNc) continue; throw err; }
      if (stopped) throw phaseError("unavailable");
      const current = opts?.currentNc?.();
      if (current && current !== activeNc) subscribe(current);
      if (preparing === activeNc) { progressReady = true; break; }
    }
    if (stopped) throw phaseError("unavailable");
    submitted = true;
    let attributed: EpAttributedReply;
    try { attributed = await bounded(() => submit(work.signal), deadline); }
    catch (err) {
      if (stopped) throw phaseError("unavailable");
      if (err instanceof EpEnvelopeError && err.outcome === "not-executed") throw err;
      throw new EpEnvelopeError(err instanceof EpEnvelopeError ? err.code : "unavailable",
        `${err instanceof Error ? err.message : String(err)}; the submission outcome is unknown. It may have been accepted or executed; do NOT retry without inspecting 'ps'/'inspect' first (SPEC 13.6)`, undefined, "unknown");
    }
    if (attributed.reply.ok !== true) return attributed;
    const acceptance = attributed.reply.data as { goalId?: unknown; fingerprint?: unknown; readinessDeadlineMs?: unknown } | undefined;
    const goalId = acceptance?.goalId;
    if (typeof goalId !== "string") return attributed;
    const acceptedFingerprint = typeof acceptance?.fingerprint === "string" ? acceptance.fingerprint : undefined;
    const readinessDeadlineMs = acceptance?.readinessDeadlineMs;
    const followDeadlineMs = typeof readinessDeadlineMs === "number"
      && Number.isSafeInteger(readinessDeadlineMs) && readinessDeadlineMs >= 0
      ? Math.max(deadlineMs, readinessDeadlineMs + GOAL_FOLLOW_MARGIN_MS) : deadlineMs;
    deadline = Date.now() + followDeadlineMs;
    const reconcileAt = deadline - Math.min(deadlineMs, followDeadlineMs / 2);
    let finalReadRequested = false;
    const reconcile = async () => {
      if (!opts?.reconcile || completed || stopped || reading || !progressReady) return;
      reading = true;
      needsReconcile = false;
      try {
        const result = await opts.reconcile(goalId, attributed, {
          caller: { ...acceptingCaller }, signal: work.signal, deadlineMs: Math.max(1, deadline - Date.now()),
        });
        if (completed || stopped || Date.now() >= deadline) return;
        if (!result || typeof result !== "object" || result.goalId !== goalId)
          throw new EpEnvelopeError("internal", "goal-result reply is malformed or names a different goal; it cannot authorize this outcome (SPEC 13.6)");
        if (result.result !== undefined) {
          const ref: GoalRef = { endpoint, caller: acceptingCaller, goalId };
          const fact = await verifyFact(result.result, "goal-result reply", ref);
          if (acceptedFingerprint !== undefined && fact.fingerprint !== acceptedFingerprint)
            throw new EpEnvelopeError("internal", "goal result fingerprint does not match the accepted goal (SPEC 13.6)");
          terminals.set(goalId, { state: fact.state, data: fact.data });
        }
      } catch (err) {
        if (!completed && !stopped && Date.now() < deadline)
          observationError = err instanceof Error ? err : new Error(String(err));
      } finally {
        reading = false;
        if (!completed && !stopped) wake?.();
      }
    };
    const current = opts?.currentNc?.();
    if (current && current !== activeNc && !stopped) replaceConnection(current);
    needsReconcile = true; // Also covers a terminal lost before the acceptance arrived.
    while (!terminals.has(goalId) && !stopped && !observationError && !subError && Date.now() < deadline) {
      if (!finalReadRequested && Date.now() >= reconcileAt) {
        finalReadRequested = true;
        needsReconcile = true;
      }
      if (needsReconcile && !reading) void reconcile();
      if (terminals.has(goalId) || stopped || observationError || subError) break;
      await new Promise<void>((resolve) => {
        const until = finalReadRequested ? deadline : reconcileAt;
        const timer = setTimeout(() => { timers.delete(timer); wake = undefined; resolve(); }, Math.max(0, Math.min(until - Date.now(), 2_147_483_647)));
        timers.add(timer);
        wake = () => { clearTimeout(timer); timers.delete(timer); wake = undefined; resolve(); };
      });
    }
    const terminal = terminals.get(goalId);
    const observationFailure = (code: "unavailable" | "permission-denied" | "deadline-exceeded", reason: string) => ({
      ...attributed,
      reply: { ...attributed.reply, ok: false as const, data: undefined, error: {
        code, outcome: "unknown" as const,
        message: `the goal "${goalId}" was accepted, but ${reason}. THE GOAL IS UNAFFECTED - it may already have succeeded; this is not evidence the goal failed. Do NOT retry: another submission could duplicate the effect. Inspect 'ps'/'inspect' first (SPEC 13.6)`,
      } },
    });
    if (stopped) return observationFailure("unavailable", "the endpoint was stopped while awaiting its outcome");
    if (observationError) return observationFailure("unavailable", `following its outcome failed: ${observationError.message}`);
    if (!terminal && subError) return subError instanceof PermissionViolationError
      ? observationFailure("permission-denied", `this caller is NOT PERMITTED to hear its outcome: the broker refused the per-goal progress subscription \"${progressSubject}\" (${subError.message}); grant this caller the per-goal progress read row`)
      : observationFailure("unavailable", `the per-goal progress subscription \"${progressSubject}\" FAILED (${subError.name}: ${subError.message}); this is NOT a grant refusal, so changing ACLs is the wrong remedy`);
    if (!terminal) return observationFailure("deadline-exceeded", `no terminal arrived within ${followDeadlineMs}ms; this is a timeout on the WAIT`);
    if (terminal.state === "succeeded")
      return { ...attributed, reply: { ...attributed.reply, ok: true, data: terminal.data, error: undefined } };
    const d = (terminal.data ?? {}) as { error?: unknown; reason?: unknown; details?: unknown };
    const raw = typeof d.error === "string" ? d.error : typeof d.reason === "string" ? d.reason : `the goal settled ${terminal.state}`;
    const details = Array.isArray(d.details) ? d.details as import("./endpoint-error.js").EpErrorDetail[] : undefined;
    const message = renderLifecycleBlocked(raw, details ? { details } : undefined);
    const fromAccept = lifecycleBlockedFrom(attributed.reply.error);
    const merged = details ?? (fromAccept ? [fromAccept] : undefined);
    return { ...attributed, reply: { ...attributed.reply, ok: false, error: { code: terminal.state, message, ...(merged ? { details: merged } : {}) } } };
  } finally {
    completed = true;
    opts?.signal?.removeEventListener("abort", onAbort);
    unbindReconnect?.();
    activeSub?.unsubscribe();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    wake = undefined;
    work.abort();
    abortPhase?.();
  }
}
