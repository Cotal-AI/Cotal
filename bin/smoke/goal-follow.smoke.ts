/**
 * The goal-follow subscription contract (#610): a caller that is REFUSED its per-goal progress
 * subscription must be told so, distinctly, and must never be handed a timeout.
 *
 * WHY A HAND-BUILT CELL, STATED RATHER THAN LEFT TO A READER. This drives
 * {@link submitAndFollowGoal} against a stub connection whose subscribe answers with an error,
 * because the failure it grades cannot be minted through the public API any more: since the
 * companion fix in `provision.ts`, a spawn-capable credential CARRIES the progress row, so the
 * denial this cell needs is no longer reachable from a real credential. That is the right outcome
 * for the product and it leaves this branch testable only by construction. It therefore proves the
 * BRANCH, not that a real door reaches it; `smoke:user-spawn:live` carries the end-to-end half
 * (a spawn-scope caller following its own goal to terminal over a real authed mesh).
 *
 * The distinction matters because the two failures want opposite responses from an operator: a
 * timeout invites a retry, and a retry submits a second goal and duplicates the effect (#605
 * records one duplicate created exactly that way). A denial wants a grant.
 *
 * Run: pnpm smoke:goal-follow
 */
import { submitAndFollowGoal } from "@cotal-ai/core";
import { PermissionViolationError } from "@nats-io/transport-node";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const CALLER = { owner: "u_probe", actor: "cli", uid: "0123456789abcdefghijklmnopqrst" };
const GOAL = "goal-follow-probe";
const SUBJECT = "cotal.s.epe.manager.*.*.goal.u_probe.cli.0123456789abcdefghijklmnopqrst.>";
const DENIAL = `permission denied: cannot subscription "${SUBJECT}"`;
/** As on the wire: a reply names the responder that answered it, and that responder publishes
 *  progress under its own instance and epoch. Only that publisher settles the goal it accepted. */
const RESPONDER = { endpoint: "manager", instanceId: "i1", epoch: 0 };
const progressSubject = (instanceId: string, epoch: number, goalId: string) =>
  `cotal.s.epe.manager.${instanceId}.${epoch}.goal.u_probe.cli.0123456789abcdefghijklmnopqrst.${goalId}.progress`;

/** A connection whose subscribe is REFUSED: the callback is handed an error and no message ever
 *  arrives, which is exactly what a broker-denied subscription looks like from inside the client. */
const deniedConn = {
  flush: async () => {},
  subscribe: (_subject: string, opts: { callback: (err: Error | null, m: unknown) => void }) => {
    // The REAL class the client delivers here, not a stand-in Error. The reply's diagnosis now keys
    // on it, so a fixture carrying a plain Error would assert the branch while quietly assuming the
    // shape, and would keep passing if the client ever stopped delivering this class.
    queueMicrotask(() => opts.callback(new PermissionViolationError(DENIAL, "subscription", SUBJECT), undefined));
    return { unsubscribe: () => {} };
  },
};

/** A connection whose subscribe fails for a reason that is NOT a grant refusal. The subscription is
 *  just as dead, so this must be just as loud, but the cause and the remedy differ and the reply
 *  must not claim the broker refused a grant. */
const brokenConn = {
  flush: async () => {},
  subscribe: (_subject: string, opts: { callback: (err: Error | null, m: unknown) => void }) => {
    queueMicrotask(() => opts.callback(new Error("connection closed while subscribing"), undefined));
    return { unsubscribe: () => {} };
  },
};

/** Acceptance REFUSED at submit, paired with a connection already denied: the ordering question.
 *  The refusal must survive unchanged, because a subscription denial says nothing about a goal that
 *  was never accepted, and claiming acceptance there would strand a goal that never ran. */
const refuseAtAccept = () => Promise.resolve({
  reply: { ok: false as const, data: undefined, error: { code: "failed-precondition", message: "refused at accept" } },
  responder: RESPONDER,
});

/** A connection whose subscribe succeeds and never delivers: the ordinary "no terminal yet" case,
 *  which must keep reporting a DEADLINE and must not be reworded by this change. */
const silentConn = {
  flush: async () => {},
  subscribe: (_subject: string, _opts: { callback: (err: Error | null, m: unknown) => void }) => ({ unsubscribe: () => {} }),
};

const acceptance = () => Promise.resolve({
  reply: { ok: true as const, data: { goalId: GOAL } },
  responder: RESPONDER,
});

const boundedAcceptance = () => Promise.resolve({
  reply: { ok: true as const, data: { goalId: GOAL, readinessDeadlineMs: 400 } },
  responder: RESPONDER,
});

console.log("A. a REFUSED progress subscription is reported as a refusal, not as a timeout");
{
  const t0 = Date.now();
  const r = await submitAndFollowGoal(deniedConn as never, "s", "manager", CALLER, 20_000, acceptance as never);
  const elapsed = Date.now() - t0;
  const msg = r.reply.error?.message ?? "";
  // THE ASSERTION THIS FIX EXISTS FOR. Before it, the denial was discarded at the callback
  // (`if (err) return;`) and this call sat until its deadline and then blamed the goal.
  ok("the reply is a refusal, not a deadline", r.reply.error?.code === "permission-denied", r.reply.error);
  ok("...naming the denied subscription so the remedy is findable", msg.includes("per-goal progress subscription"), msg);
  ok("...stating the goal is unaffected rather than failed", msg.includes("THE GOAL IS UNAFFECTED"), msg);
  ok("...and telling the operator NOT to retry (a retry duplicates the effect)", msg.includes("Do NOT retry"), msg);
  // A denial is knowable the moment it arrives, so the caller must not be held to its deadline:
  // 20s budget, and this has to come back immediately.
  ok(`...returned at once rather than after the deadline (${elapsed}ms of 20000ms)`, elapsed < 5_000, elapsed);
}

console.log("B. an ordinary silent wait still reports a DEADLINE (the change is narrow)");
{
  const r = await submitAndFollowGoal(silentConn as never, "s", "manager", CALLER, 300, acceptance as never);
  ok("a subscribed-but-silent follow still times out", r.reply.error?.code === "deadline-exceeded", r.reply.error);
  ok("...and still says the timeout is about the WAIT, not the work", (r.reply.error?.message ?? "").includes("timeout on the WAIT"), r.reply.error?.message);
}

console.log("C. a NON-permission subscription failure is just as loud, with a truthful cause");
{
  const t0 = Date.now();
  const r = await submitAndFollowGoal(brokenConn as never, "s", "manager", CALLER, 20_000, acceptance as never);
  const elapsed = Date.now() - t0;
  const msg = r.reply.error?.message ?? "";
  // The SURFACE must not narrow with the diagnosis: if only the permission class were surfaced,
  // every other class would fall back through to the deadline, which is this defect again in
  // miniature.
  ok("a non-permission subscription failure is NOT swallowed into a deadline", r.reply.error?.code !== "deadline-exceeded", r.reply.error);
  ok("...and is not mislabelled a grant refusal", r.reply.error?.code === "unavailable", r.reply.error);
  ok("...says plainly that ACLs are the wrong remedy", msg.includes("NOT a grant refusal"), msg);
  ok("...still states the goal is unaffected and forbids the retry", msg.includes("THE GOAL IS UNAFFECTED") && msg.includes("Do NOT retry"), msg);
  ok(`...and is knowable at once, like the denial (${elapsed}ms of 20000ms)`, elapsed < 5_000, elapsed);
}

console.log("D. a subscription denial NEVER manufactures an acceptance (the pre-accept ordering)");
{
  // The refusal text asserts "the goal was accepted" and says not to retry. If that branch were
  // reachable when submit had NOT been accepted, the same sentence would strand a goal that never
  // ran. The denial here is already pending before submit answers.
  const r = await submitAndFollowGoal(deniedConn as never, "s", "manager", CALLER, 20_000, refuseAtAccept as never);
  ok("a refusal at accept survives the pending subscription denial unchanged", r.reply.error?.code === "failed-precondition", r.reply.error);
  ok("...and no acceptance is claimed for a goal that was never accepted", !(r.reply.error?.message ?? "").includes("was accepted"), r.reply.error?.message);
}

console.log("E. the accepted readiness budget, not a shorter generic caller wait, bounds the follow");
{
  const delayedTerminalConn = {
    flush: async () => {},
    subscribe: (_subject: string, opts: { callback: (err: Error | null, m: { subject: string; data: Uint8Array }) => void }) => {
      const timer = setTimeout(() => opts.callback(null, {
        subject: progressSubject("i1", 0, GOAL),
        data: new TextEncoder().encode(JSON.stringify({ goalId: GOAL, phase: "terminal", state: "succeeded", data: { name: "slow" } })),
      }), 250);
      return { unsubscribe: () => clearTimeout(timer) };
    },
  };
  const r = await submitAndFollowGoal(delayedTerminalConn as never, "s", "manager", CALLER, 100, boundedAcceptance as never);
  ok("a terminal inside the accepted readiness budget outlives the shorter generic caller wait", r.reply.ok === true, r.reply);
}

console.log("F. only the instance and epoch that accepted the goal settle it from live progress");
{
  // Each publisher below may be a real one (the broker vouches for a subject's instance and epoch),
  // but none accepted this goal, or its body names another goal than its subject. None may settle it.
  const terminal = (subject: string, goalId: string) => ({
    subject, data: new TextEncoder().encode(JSON.stringify({ goalId, phase: "terminal", state: "succeeded", data: { by: subject } })),
  });
  const forged = [
    terminal(progressSubject("i2", 0, GOAL), GOAL),
    terminal(progressSubject("i1", 1, GOAL), GOAL),
    terminal(progressSubject("i1", 0, "other-goal"), GOAL),
    terminal(progressSubject("i1", 0, GOAL), "other-goal"),
    terminal(`cotal.s.epe.manager.i1.0.goal.u_other.cli.0123456789abcdefghijklmnopqrst.${GOAL}.progress`, GOAL),
  ];
  const connWith = (messages: { subject: string; data: Uint8Array }[]) => ({
    flush: async () => {},
    subscribe: (_subject: string, opts: { callback: (err: Error | null, m: unknown) => void }) => {
      const timer = setTimeout(() => { for (const m of messages) opts.callback(null, m); }, 20);
      return { unsubscribe: () => clearTimeout(timer) };
    },
  });
  const r = await submitAndFollowGoal(connWith(forged) as never, "s", "manager", CALLER, 400, acceptance as never);
  ok(`${forged.length} terminals from publishers that did not accept the goal settle nothing`, r.reply.error?.code === "deadline-exceeded", r.reply);
  const genuine = terminal(progressSubject("i1", 0, GOAL), GOAL);
  const settled = await submitAndFollowGoal(connWith([...forged, genuine]) as never, "s", "manager", CALLER, 5_000, acceptance as never);
  ok("...while the accepting publisher's own terminal settles it, with its data", settled.reply.ok === true
    && (settled.reply.data as { by?: string } | undefined)?.by === genuine.subject, settled.reply);
}

console.log(`\ngoal-follow smoke passed (${pass} checks)`);
