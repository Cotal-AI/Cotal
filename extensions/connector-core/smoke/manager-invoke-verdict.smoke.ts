/**
 * WHAT A PEER-SIDE MANAGER CALL TELLS AN AGENT WHEN IT FAILS.
 *
 * `MeshAgent.managerInvoke` renders every manager-endpoint failure into the one line the `cotal_*`
 * tools hand back to an agent. It used to decide "nobody answered" from the CATALOG CODE — anything
 * `deadline-exceeded` got *"no responder answered - a manager may be down, or this credential holds
 * no <cmd> capability and the broker denied the request"*, and everything else got its bare code.
 * The code is not evidence of silence, and keying on it was wrong in BOTH directions:
 *
 *   - The broker's no-responders 503 is raised as `unavailable`, WITH the marker (endpoint-verbs
 *     `epCall`). That is the case where the capability-denial explanation is most certain, and the
 *     code-keyed branch was the one case that withheld it.
 *   - An answered `ok:false` describe is ALSO `unavailable`, WITHOUT the marker, and deliberately so.
 *     A manager answered. Telling an agent nobody did invites the retry that duplicates a spawn.
 *
 * THE AMBIGUOUS CELL, AND ITS TWIN. `unavailable` is correct under both conditions above, so no
 * single cell here pins anything. Cells 1 and 3 are the same code with the marker present and
 * absent, and they must render OPPOSITELY; either alone would stay green under a renderer that
 * ignored the marker entirely.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. The errors below are CONSTRUCTED, so this grades the rendering
 * and nothing about the wire. That core attaches the marker exactly where it observed silence and
 * withholds it where a responder answered is gated separately and live, in `smoke:ep-invoke`
 * (`endpoint-invoke.smoke.ts:127` the deadline IS marked, `:139` an answered ok:false is NOT — "the
 * code alone is not evidence of silence"). Neither suite is sufficient alone.
 *
 * No broker: the MeshAgent constructor builds an endpoint but never connects, so `ep` is swapped for
 * one that throws. Run: pnpm smoke:manager-invoke-verdict
 */
import { EpEnvelopeError, EP_UNANSWERED, EP_UNBOUND_RESPONDER, managerCallerBinding } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";

let pass = 0, fail = 0;
/** A cell RECORDS its verdict; it never throws. A throwing cell takes every cell below it with it,
 *  which turns one defect into a suite that reports nothing about anything after it. The tick is the
 *  repo's, not a word of this file's own: `mutation-proof` counts those ticks to tell "failed at my
 *  assertion" from "died before reaching it", and a suite that invents its own glyph reports zero
 *  marks and gives up that protection without saying so. */
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
};

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};

/** Render one failure through the real `managerInvoke`. `purgeHistory` is the shortest public path
 *  to it: no target block, no goal follow, so nothing between the throw and the rendering. */
async function render(thrown: unknown): Promise<string> {
  const a = new MeshAgent(cfg);
  (a as unknown as { ep: { invokeService: () => Promise<never>; principal: { owner: string; actor: string } } }).ep = {
    invokeService: () => Promise.reject(thrown),
    principal: { owner: "local", actor: "caller" },
  };
  (a as unknown as { _connected: boolean })._connected = true;
  const r = await a.purgeHistory();
  return r.ok === false ? (r.error ?? "") : `UNEXPECTED ok:true`;
}

const SILENCE = /no responder answered/;
const unanswered = { kind: EP_UNANSWERED, endpoint: "manager", command: "purge" };

console.log("the verdict comes from the marker, not the code:");

// 1. The live change. Broker no-responders is `unavailable` and carries the marker; the old
//    code-keyed branch printed the bare code and dropped the one explanation that was certain.
const noResponders = await render(new EpEnvelopeError("unavailable", "no responder for manager.purge (SPEC 13.5)", [unanswered]));
check("no-responders 503 (`unavailable`, MARKED) says nobody answered", SILENCE.test(noResponders), noResponders);
check("...and names the capability as a cause, which is what the code-keyed branch withheld",
  /capability and the broker denied/.test(noResponders), noResponders);

// 2. Unchanged: a describe that drew no reply at all.
const deadline = await render(new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms", [unanswered]));
check("an UNANSWERED deadline still says nobody answered", SILENCE.test(deadline), deadline);

// 3. THE TWIN of cell 1 — same code, no marker, opposite verdict. A manager answered.
const answered = await render(new EpEnvelopeError("unavailable", "describe(manager) failed: trusted auth view failed"));
check("an ANSWERED ok:false describe (`unavailable`, UNMARKED) does NOT say nobody answered", !SILENCE.test(answered), answered);
check("...it prints the responder's own cause under its own code",
  answered === "unavailable: describe(manager) failed: trusted auth view failed", answered);

// 4. The split. A responder handled the request; the effect may have landed. Core's account is what
//    an agent must read here, and it must not be overwritten with a claim of silence.
const split = await render(new EpEnvelopeError("failed-precondition",
  "instance A won the class queue but this UNPINNED handle resolved against B - THIS SAYS NOTHING ABOUT WHETHER THE COMMAND RAN",
  [{ kind: EP_UNBOUND_RESPONDER, endpoint: "manager", command: "purge", answeredBy: "A", boundTo: "B", pinned: false }]));
check("a class-queue split does NOT say nobody answered", !SILENCE.test(split), split);
check("...and core's account survives intact", split.includes("SAYS NOTHING ABOUT WHETHER THE COMMAND RAN"), split);

// 5. A failure carrying no envelope carries no provenance either, so no verdict is stated for it.
const plain = await render(new Error("connection closed"));
check("a non-envelope failure states no verdict at all", !SILENCE.test(plain) && plain === "connection closed", plain);

// Constructed claims grade coordinate parsing only; broker signature checks and issuer policy
// are not exercised by this file. No bearer command or connection is started here.
const owner = `u_${"a".repeat(26)}`;
const uid = "c".repeat(26), instanceId = "a".repeat(26);
const managerConfig: AgentConfig = {
  ...cfg, lifecycleUid: uid, managerInstanceId: instanceId,
  userAuth: { owner, actor: "caller", sentinelCreds: "unused", bearerCmd: ["not-executed"] },
};
const claims = { sub: owner, aud: cfg.space, act: { owner, actor: "caller", lifecycleUid: uid, view: "manager-caller", managerInstanceId: instanceId } };
const token = (value: unknown) => `unused.${Buffer.from(JSON.stringify(value)).toString("base64url")}.unused`;
const expected = { space: cfg.space, owner, actor: "caller", lifecycleUid: uid, instanceId };
const binding = managerCallerBinding(token(claims), expected);
check("manager control binds the exact server-selected instance and caller", binding.instanceId === instanceId && binding.caller.owner === owner && binding.caller.actor === "caller" && binding.caller.uid === uid);
check("an unpinned client uses the issuer's concrete selection", managerCallerBinding(token(claims), { ...expected, instanceId: undefined }).instanceId === instanceId);
const wrongClaims = [
  { ...claims, aud: "other-space" },
  { ...claims, sub: `u_${"b".repeat(26)}` },
  { ...claims, act: { ...claims.act, view: "admin" } },
  { ...claims, act: { ...claims.act, owner: `u_${"b".repeat(26)}` } },
  { ...claims, act: { ...claims.act, actor: "other" } },
  { ...claims, act: { ...claims.act, lifecycleUid: "d".repeat(26) } },
  { ...claims, act: { ...claims.act, managerInstanceId: "b".repeat(26) } },
  { ...claims, act: { ...claims.act, managerInstanceId: undefined } },
  { ...claims, act: { ...claims.act, managerInstanceId: "*" } },
];
for (const [index, value] of wrongClaims.entries()) {
  let refused = false;
  try { managerCallerBinding(token(value), expected); } catch { refused = true; }
  check(`manager control refuses foreign or malformed coordinates ${index + 1}`, refused);
}
let malformedRefused = false;
try { managerCallerBinding("not-a-bearer", expected); } catch { malformedRefused = true; }
check("manager control refuses an unparseable bearer", malformedRefused);

// This constructed endpoint grades dispatch only, not renewal or broker delivery. It deliberately
// does not execute the submission: the bearer helper must not run before the follower owns it.
const spawning = new MeshAgent(managerConfig);
let followedOnMain = false;
const standing = {
  principal: { owner, actor: "caller" },
  followServiceGoal: async (endpoint: string, submit: unknown, deadlineMs: number) => {
    followedOnMain = endpoint === "manager" && typeof submit === "function" && deadlineMs >= 40_000;
    return { reply: { ok: true, data: { name: "followed" } } };
  },
};
(spawning as unknown as { ep: unknown }).ep = standing;
(spawning as unknown as { _connected: boolean })._connected = true;
const spawned = await spawning.spawn("reviewer");
check("user spawn delegates follow to its standing endpoint before executing the bearer helper",
  followedOnMain && spawned.ok && (spawned.data as { name?: string })?.name === "followed" &&
  (spawning as unknown as { ep: unknown }).ep === standing);

// Dispatch checks only. The native two-manager replay supplies the process-exit proof.
const selfCalls: Array<{ command: string; args: unknown; opts: { instanceId?: string; target?: unknown } }> = [];
function selfAgent(config: AgentConfig): MeshAgent {
  const agent = new MeshAgent(config);
  (agent as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "caller" },
    invokeService: async (_endpoint: string, command: string, args: unknown, opts: { instanceId?: string; target?: unknown }) => {
      selfCalls.push({ command, args, opts });
      return { reply: { ok: true, data: { stopped: true } } };
    },
  };
  (agent as unknown as { _connected: boolean })._connected = true;
  return agent;
}
const openSelf = selfAgent({ ...cfg, managerInstanceId: instanceId });
await openSelf.despawn(undefined, { graceful: false });
check("open managed self-stop pins the launching manager", selfCalls.at(-1)?.opts.instanceId === instanceId);
check("self-stop retains its self authorization mode", selfCalls.at(-1)?.command === "stop" && JSON.stringify(selfCalls.at(-1)?.opts.target) === '{"mode":"self"}');
check("self-stop preserves explicit hard-stop selection", JSON.stringify(selfCalls.at(-1)?.args) === '{"graceful":false}');
await selfAgent(cfg).despawn();
check("an unbound open caller retains the class route", selfCalls.at(-1)?.opts.instanceId === undefined);
await selfAgent({ ...cfg, id: "caller", managerInstanceId: instanceId, creds: async () => "not-used" }).despawn();
check("static self-stop preserves its class-only credential grants", selfCalls.at(-1)?.opts.instanceId === undefined);
const beforeRefusals = selfCalls.length;
const conversation = await selfAgent({ ...cfg, managerInstanceId: instanceId, turnRelay: false }).despawn();
check("conversation self-stop refuses without dispatch", !conversation.ok && selfCalls.length === beforeRefusals);
const overrideSelf = await openSelf.despawn(undefined, { instance: "b".repeat(26) });
check("a self-stop instance override still refuses without dispatch", !overrideSelf.ok && selfCalls.length === beforeRefusals);

// Dispatch only. The native two-manager replay supplies catalog and pending-goal evidence.
for (const [label, config, expected] of [
  ["open managed", { ...cfg, managerInstanceId: instanceId }, instanceId],
  ["open unbound", cfg, undefined],
  ["static managed", { ...cfg, id: "caller", managerInstanceId: instanceId, creds: async () => "not-used" }, undefined],
] as const) {
  const agent = selfAgent(config);
  await agent.definePersona({ name: "owned", prompt: "Owned fixture" });
  check(`${label} persona definition preserves its route`, selfCalls.at(-1)?.opts.instanceId === expected);
  await agent.listPersonas();
  check(`${label} persona listing preserves its route`, selfCalls.at(-1)?.opts.instanceId === expected);
  await agent.showPersona("owned");
  check(`${label} persona show preserves its route`, selfCalls.at(-1)?.opts.instanceId === expected);
  await agent.spawn("owned");
  check(`${label} spawn preserves its route`, selfCalls.at(-1)?.opts.instanceId === expected);
}
const explicit = selfAgent({ ...cfg, managerInstanceId: instanceId });
await explicit.listPersonas("b".repeat(26));
check("an existing explicit open persona selector stays explicit", selfCalls.at(-1)?.opts.instanceId === "b".repeat(26));

for (const [label, config, expected] of [
  ["open managed", { ...cfg, managerInstanceId: instanceId }, instanceId],
  ["open unbound", cfg, undefined],
  ["static managed", { ...cfg, id: "caller", managerInstanceId: instanceId, creds: async () => "not-used" }, undefined],
  ["user managed", managerConfig, undefined],
] as const) {
  const calls: Array<{ endpoint: string; opts: { instanceId?: string; target?: { mode: string } } }> = [];
  const agent = new MeshAgent(config);
  (agent as unknown as { ep: unknown }).ep = {
    describeService: async (endpoint: string, opts: { instanceId?: string }) => {
      calls.push({ endpoint, opts });
      return { endpoint, owner: "local", responder: { instanceId, epoch: 0 }, commands: new Map() };
    },
    invokeService: async (endpoint: string, _command: string, _args: unknown, opts: { instanceId?: string; target?: { mode: string } }) => {
      calls.push({ endpoint, opts });
      return { reply: { ok: true, data: { turns: [] } }, responder: { instanceId, epoch: 0 } };
    },
  };
  const tools = cotalToolSpecs(config);
  await tools.find(t => t.name === "cotal_describe")!.run(agent, config, { endpoint: "manager", refresh: true });
  check(`${label} generic manager describe preserves credential routing`, calls.at(-1)?.opts.instanceId === expected);
  await tools.find(t => t.name === "cotal_invoke")!.run(agent, config, { endpoint: "manager", command: "turn-pending", self: true });
  check(`${label} generic manager self read preserves credential routing`, calls.at(-1)?.opts.instanceId === expected && calls.at(-1)?.opts.target?.mode === "self");
  await tools.find(t => t.name === "cotal_invoke")!.run(agent, config, { endpoint: "other", command: "read", self: true });
  check(`${label} another endpoint never receives a manager pin`, calls.at(-1)?.opts.instanceId === undefined);
  await tools.find(t => t.name === "cotal_invoke")!.run(agent, config, { endpoint: "manager", command: "status" });
  check(`${label} generic untargeted call retains its existing class route`, calls.at(-1)?.opts.instanceId === undefined);
}

// Constructed throw exercises the actual managerInvoke -> spawn -> tool rendering pipeline.
// The paused-manager live replay supplies publication, late acceptance and goal-to-seat proof.
{
  const goalId = "published_spawn_request";
  const tools = cotalToolSpecs(cfg);
  const spawnTool = tools.find(t => t.name === "cotal_spawn")!;
  const unknown = async (error: EpEnvelopeError, model?: string) => {
    const agent = new MeshAgent(cfg);
    let calls = 0;
    (agent as unknown as { ep: unknown }).ep = {
      invokeService: async () => { calls++; throw error; }, principal: { owner: "local", actor: "caller" },
    };
    (agent as unknown as { _connected: boolean })._connected = true;
    const result = await spawnTool.run(agent, cfg, { name: "reviewer", ...(model ? { model } : {}) });
    return { result, calls };
  };
  const submitted = new EpEnvelopeError("deadline-exceeded", "submission outcome is unknown", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "spawn", requestId: goalId }], "unknown");
  const { result, calls } = await unknown(submitted);
  check("an unknown submitted spawn is not reported as a plain failure", !result.isError && result.structured?.status === "unknown", result);
  check("unknown spawn text and structured data retain the same goal", result.text.includes(`goal "${goalId}"`) && result.structured?.goalId === goalId, result);
  check("unknown spawn gives an existing same-caller goal-result read", result.text.includes('command="goal-result"') && result.text.includes("as this same caller"), result);
  check("unknown spawn forbids retry and treats missing readback as inconclusive", result.text.includes("Do NOT retry") && result.text.includes("missing result does not prove"), result);
  check("the unknown result neither resubmits nor claims confirmed acceptance", calls === 1 && result.text.includes("Acceptance has not been confirmed"), { result, calls });
  const pinned = await unknown(submitted, "requested-model");
  check("a requested model does not discard the unknown goal or inspect an unallocated alias", pinned.calls === 1 && pinned.result.structured?.goalId === goalId, pinned);
  for (const [label, error] of [
    ["describe deadline", new EpEnvelopeError("deadline-exceeded", "no describe reply", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "describe", requestId: goalId }])],
    ["broker no responder", new EpEnvelopeError("unavailable", "no responder", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "spawn", requestId: goalId }], "not-executed")],
    ["malformed request id", new EpEnvelopeError("deadline-exceeded", "unknown", [{ kind: EP_UNANSWERED, endpoint: "manager", command: "spawn", requestId: "invalid.id" }], "unknown")],
    ["another endpoint", new EpEnvelopeError("deadline-exceeded", "unknown", [{ kind: EP_UNANSWERED, endpoint: "other", command: "spawn", requestId: goalId }], "unknown")],
  ] as const) {
    const r = await unknown(error);
    check(`${label} never manufactures a recoverable spawn goal`, r.result.isError === true && r.result.structured?.goalId === undefined, r);
  }
}

const EXPECTED_CELLS = 67;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
