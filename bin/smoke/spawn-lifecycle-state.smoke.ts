/**
 * Spawn failures return lifecycle state (#873): a knowable manager-side refusal
 * (blocked op, head state, opId, remedy) must reach the spawn caller instead of
 * collapsing to a connector timeout or "unknown".
 *
 * Two halves of one path, both required:
 *   A. A lifecycle-blocked envelope, followed as a failed goal terminal, keeps
 *      the facts on the reply the spawn caller sees.
 *   B. MeshAgent.managerInvoke and cotal_spawn render those facts into the
 *      string an agent/operator actually reads.
 *
 * No broker: follow is driven against a stub connection that never delivers,
 * because the terminal is already in the map when submit returns. The MeshAgent
 * half never connects; invokeService is swapped for a throw/reply.
 *
 * Run: pnpm smoke:spawn-lifecycle-state
 */
import { submitAndFollowGoal, lifecycleBlocked, EP_LIFECYCLE_BLOCKED, lifecycleBlockedFrom } from "@cotal-ai/core";
import { MeshAgent, cotalToolSpecs, type AgentConfig } from "@cotal-ai/connector-core";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
};

const CALLER = { owner: "u_probe", actor: "cli", uid: "0123456789abcdefghijklmnopqrst" };
const GOAL = "goal-lifecycle-probe";
const OPID = "a".repeat(26);

const silentConn = {
  subscribe: (_subject: string, _opts: { callback: (err: Error | null, m: unknown) => void }) => ({ unsubscribe: () => {} }),
};

const blocked = lifecycleBlocked("conflict",
  `the issuance gate for "mgr-1" is frozen; another barrier holds it; if the holder is a dead predecessor, run: cotal reconcile-gate (SPEC 13.8)`,
  { blockedOp: "registration", headState: "retiring", opId: OPID, remedy: "cotal reconcile-gate" });

console.log("A. a failed goal terminal carries the lifecycle-blocked facts the manager already had");
{
  const submit = () => Promise.resolve({
    reply: { ok: true as const, data: { goalId: GOAL } },
    instanceId: "i1",
    epoch: 0,
  });
  // The terminal is already knowable: publish it by resolving submit after the
  // subscription is open, then deliver the event on the next tick through the
  // callback the follow path registered. A silent conn never delivers, so we
  // drive a delivering conn instead.
  let captured: ((err: Error | null, m: unknown) => void) | undefined;
  const delivering = {
    subscribe: (_subject: string, opts: { callback: (err: Error | null, m: unknown) => void }) => {
      captured = opts.callback;
      return { unsubscribe: () => {} };
    },
  };
  const submitThenEmit = async () => {
    captured?.(null, {
      data: new TextEncoder().encode(JSON.stringify({
        v: 1, goalId: GOAL, phase: "terminal", state: "failed",
        data: { error: blocked.message, details: blocked.details },
      })),
    });
    return submit();
  };
  const r = await submitAndFollowGoal(delivering as never, "s", "manager", CALLER, 5_000, submitThenEmit as never);
  const err = r.reply.error;
  const facts = lifecycleBlockedFrom(err);
  check("the follow reply is not a wait-timeout", err?.code !== "deadline-exceeded", err);
  check("the follow reply is a failed terminal, not silence", r.reply.ok === false && err?.code === "failed", err);
  check("the lifecycle-blocked marker is on the reply the spawn caller sees", facts?.kind === EP_LIFECYCLE_BLOCKED, facts);
  check("...naming the blocked op", facts?.blockedOp === "registration", facts);
  check("...naming the head state", facts?.headState === "retiring", facts);
  check("...naming the opId holding it", facts?.opId === OPID, facts);
  check("...naming the remedy", facts?.remedy === "cotal reconcile-gate", facts);
  check("the string a ControlReply caller reads still carries the facts",
    typeof err?.message === "string" && err.message.includes("blockedOp=registration") && err.message.includes(`opId=${OPID}`) && err.message.includes("remedy=cotal reconcile-gate"),
    err?.message);
}

console.log("B. a refused-at-accept envelope keeps the facts (no terminal to wait for)");
{
  const refuse = () => Promise.resolve({
    reply: { ok: false as const, data: undefined, error: blocked.toEpError() },
    instanceId: "i1",
    epoch: 0,
  });
  const r = await submitAndFollowGoal(silentConn as never, "s", "manager", CALLER, 5_000, refuse as never);
  const facts = lifecycleBlockedFrom(r.reply.error);
  check("a refuse-at-accept is not rewritten as a deadline", r.reply.error?.code === "conflict", r.reply.error);
  check("...and still carries the lifecycle-blocked marker", facts?.blockedOp === "registration" && facts.opId === OPID, facts);
}

console.log("C. MeshAgent.managerInvoke renders the facts into the string an agent reads");
{
  const cfg: AgentConfig = {
    space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
    subscribe: [], allowSubscribe: [], allowPublish: [],
  };
  const a = new MeshAgent(cfg);
  (a as unknown as { ep: { invokeService: () => Promise<never>; principal: { owner: string; actor: string } } }).ep = {
    invokeService: () => Promise.reject(blocked),
    principal: { owner: "local", actor: "caller" },
  };
  (a as unknown as { _connected: boolean })._connected = true;
  const r = await a.purgeHistory();
  check("a thrown lifecycle-blocked envelope is not reported as silence",
    r.ok === false && !(r.error ?? "").includes("no responder answered"), r);
  check("...and the rendered string names blockedOp, headState, opId, and remedy",
    typeof r.error === "string"
      && r.error.includes("blockedOp=registration")
      && r.error.includes("headState=retiring")
      && r.error.includes(`opId=${OPID}`)
      && r.error.includes("remedy=cotal reconcile-gate"),
    r.error);
  check("...and the ControlReply still carries the structured details",
    lifecycleBlockedFrom(r)?.opId === OPID, r);
}

console.log("D. cotal_spawn's tool text is the same facts, not 'manager refused'");
{
  const cfg: AgentConfig = {
    space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
    subscribe: [], allowSubscribe: [], allowPublish: [],
  };
  const agent = {
    spawn: async () => ({ ok: false, error: blocked.message, details: blocked.details }),
  };
  const spec = cotalToolSpecs(cfg, "caller").find((t) => t.name === "cotal_spawn");
  if (!spec) throw new Error("cotal_spawn spec missing");
  const out = await spec.run(agent as never, cfg, { name: "w864" });
  check("cotal_spawn reports the lifecycle facts, not an opaque manager refusal",
    out.isError === true
      && out.text.includes("Couldn't spawn w864")
      && out.text.includes("blockedOp=registration")
      && out.text.includes(`opId=${OPID}`)
      && out.text.includes("cotal reconcile-gate"),
    out);
}

const EXPECTED = 14;
const ran = pass + fail;
console.log(`\n${fail === 0 && ran === EXPECTED ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed (ran ${ran} of ${EXPECTED})`);
if (ran !== EXPECTED) process.exitCode = 1;
else process.exitCode = fail === 0 ? 0 : 1;
