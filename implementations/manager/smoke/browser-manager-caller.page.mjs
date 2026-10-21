// The page `browser-manager-caller.smoke.ts` loads in a real headless Chromium under a strict CSP.
// It drives only the public `@cotal-ai/core/browser-control` entry, with the Manager contracts the
// harness generated as a host build would, and posts what it observed back to the harness. It
// grades nothing: every cell is decided by the harness.
import * as control from "@cotal-ai/core/browser-control";
import { contracts } from "virtual:manager-contracts";

const phase = sessionStorage.getItem("phase") === "reload" ? "reload" : "first";
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }));
const obs = { phase, exports: { openBrowserManagerCaller: typeof control.openBrowserManagerCaller, verifyGoalResultFact: typeof control.verifyGoalResultFact } };

const errorOf = (e) => ({ name: e?.name, code: e?.code, outcome: e?.outcome, status: e?.status, message: String(e?.message ?? e), unanswered: control.unansweredRequest(e) });
const step = async (key, fn) => {
  try { obs[key] = { ok: true, value: await fn() }; } catch (e) { obs[key] = { ok: false, error: errorOf(e) }; }
};
const post = async (path, body) => {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const cfg = await (await fetch("/config")).json();

// The signed-in person's authority for one instance. The harness's bridge stands in for an
// embedding's backend: it forwards the person's IdP proof to the stock exchange server-side.
const authorityOf = async (instanceId) => {
  const r = await post("/bridge/exchange", { managerInstanceId: instanceId });
  if (r.status !== 200) throw Object.assign(new Error(`exchange answered ${r.status}: ${r.body?.error}`), { status: r.status });
  return { bearer: r.body.token, sentinelCreds: cfg.sentinelCreds };
};
const claimsOf = (bearer) => JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
let acquired = 0;
const open = async (instanceId, first) => {
  let pending = first ?? await authorityOf(instanceId);
  const claims = claimsOf(pending.bearer);
  return control.openBrowserManagerCaller({
    servers: cfg.wsServers, space: cfg.space, owner: claims.sub, actor: claims.act.actor, lifecycleUid: claims.act.lifecycleUid,
    instanceId, contracts, deadlineMs: 20_000,
    acquire: async () => { acquired++; const ready = pending; pending = undefined; return ready ?? authorityOf(instanceId); },
  });
};
const close = async (c) => { try { await c?.close(); } catch { /* already closed */ } };
const newGoalId = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => alphabet[b % 32]).join("");
};
const described = (c) => ({ instanceId: c.instanceId, responder: c.service.responder.instanceId, commands: c.service.commands.size });
const replyOf = (r) => ({
  outcome: r.outcome, responder: r.responder?.instanceId, ok: r.reply.ok, code: r.reply.error?.code, errorOutcome: r.reply.error?.outcome,
  message: r.reply.error?.message, data: r.reply.data,
});
const readFact = async (c, goalId) => {
  const r = await c.reconcileGoal(goalId);
  const result = r.reply.data?.result;
  const fact = result === undefined ? undefined : await control.verifyGoalResultFact(result, `goal ${goalId}`, { endpoint: "manager", caller: c.caller, goalId });
  return { ...replyOf(r), goalId: r.reply.data?.goalId, pending: r.reply.ok === true && result === undefined, state: fact?.state, committer: fact?.committer, data: undefined };
};

if (phase === "first") {
  obs.evalBlocked = (() => { try { (0, eval)("1"); return false; } catch (e) { return e instanceof EvalError; } })();
  await step("list", () => post("/bridge/manager-instances", {}));
  await step("listOther", () => post("/bridge/manager-instances", { as: "other" }));
  await step("pinMismatch", async () => {
    const forA = await authorityOf(cfg.instances.a);
    const before = acquired;
    try { await open(cfg.instances.b, forA); } finally { obs.pinMismatchAcquired = acquired - before; }
    return "opened";
  });
  let a, b;
  await step("openA", async () => described(a = await open(cfg.instances.a)));
  await step("openB", async () => described(b = await open(cfg.instances.b)));
  await step("readA", async () => replyOf(await a.invoke("list-personas")));
  await step("readB", async () => replyOf(await b.invoke("list-personas")));
  // `ps` is an operator read that stays with `admin`. The person's spawn-scoped view carries only the
  // launch reads (`status`, `models`, `resolve-cwd`).
  await step("notGranted", async () => replyOf(await a.invoke("ps")));
  const goalId = newGoalId();
  // A host persists the goal id BEFORE it submits, so a reload can read the goal back.
  sessionStorage.setItem("goal", goalId);
  await step("noId", async () => replyOf(await a.followGoal("spawn", { name: "native", cwd: cfg.cwd, events: false }, {})));
  await step("spawn", async () => replyOf(await a.followGoal("spawn", { name: "native", cwd: cfg.cwd, events: false }, { id: goalId, deadlineMs: 60_000 })));
  obs.afterSpawn = await (await fetch("/control/launches")).json();
  await step("reconcile", () => readFact(a, goalId));
  await step("tampered", async () => {
    const r = await a.reconcileGoal(goalId);
    const result = { ...r.reply.data.result, data: { tampered: true } };
    await control.verifyGoalResultFact(result, `goal ${goalId}`, { endpoint: "manager", caller: a.caller, goalId });
    return "accepted";
  });
  await step("refused", async () => replyOf(await a.followGoal("spawn", { name: "missing", cwd: cfg.cwd, events: false }, { id: newGoalId(), deadlineMs: 20_000 })));
  const slowGoal = newGoalId();
  sessionStorage.setItem("slow", slowGoal);
  await step("unknown", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), cfg.abortAfterMs);
    return replyOf(await a.followGoal("spawn", { name: "slow", cwd: cfg.cwd, events: false }, { id: slowGoal, deadlineMs: 60_000, signal: stop.signal }));
  });
  // The follow stopped; the Manager still runs the goal it accepted. Wait for its one launch, then read it.
  for (let i = 0; i < 40 && (obs.afterUnknown = await (await fetch("/control/launches")).json()).slow < 1; i++) await new Promise((r) => setTimeout(r, 500));
  await step("unknownRead", () => readFact(a, slowGoal));
  // Manager B forges terminals for a goal followed on A; A's own terminal must be what the follow returns.
  const decoyGoal = newGoalId();
  await step("hostile", async () => {
    await post("/control/forge", { goalId: decoyGoal, caller: { owner: a.caller.owner, actor: a.caller.actor, uid: a.caller.uid } });
    return replyOf(await a.followGoal("spawn", { name: "decoy", cwd: cfg.cwd, events: false }, { id: decoyGoal, deadlineMs: 60_000 }));
  });
  obs.forge = (await post("/control/forge-report", {})).body;
  await step("stopB", () => post("/control/stop-b", {}));
  await step("unavailable", async () => replyOf(await b.invoke("list-personas", undefined, { deadlineMs: 3_000 })));
  await close(a); await close(b);
  obs.violations = violations;
  await post("/result", obs);
  sessionStorage.setItem("phase", "reload");
  location.reload();
} else {
  // After a reload the recorded goals are read back through `goal-result`, never submitted again.
  const goalId = sessionStorage.getItem("goal"), slowGoal = sessionStorage.getItem("slow");
  let a;
  await step("reopenA", async () => described(a = await open(cfg.instances.a)));
  await step("reloadRead", () => readFact(a, goalId));
  await step("slowSettled", async () => {
    for (let reads = 1; reads <= 80; reads++) {
      const read = await readFact(a, slowGoal);
      if (!read.pending) return { ...read, reads };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { pending: true };
  });
  await close(a);
  obs.violations = violations;
  await post("/result", obs);
}
