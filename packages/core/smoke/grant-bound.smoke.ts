/** The delegation bound: a grant is tested against the spawner's evidence at the spawner's own
 *  coordinate, and each part it does not hold is named. Each ceiling here is the evidence an agent
 *  mint records (provision.ts imports the minted permissions verbatim). No broker. */
import { permissionsFor, type MintOpts } from "../src/provision.js";
import { importNativeSubjectPermissions, mintAcceptedToken, mintGeneration, type IssuedSubjectPermissions } from "../src/issued-authority.js";
import { capabilityWithin, grantOverreach, type DelegatedGrant, type GrantOverreach } from "../src/grant-bound.js";
import type { IssuedCaller } from "../src/endpoint-subjects.js";
import { spacePrefix } from "../src/subjects.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) {
    fail++;
    console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
    return;
  }
  pass++;
  console.log(`  ✓ ${name}`);
};

const space = "gb";
const caller: IssuedCaller = {
  owner: "local",
  actor: "UPARENTACTOR0000000000000000000000000000000000000000000",
  uid: "u0000000000000000000000000",
  generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600),
} as IssuedCaller;

/** The evidence the spawner's own mint records, for a spawner holding `opts`. */
const evidence = (opts: Omit<MintOpts, "lifecycleUid" | "issued">): IssuedSubjectPermissions =>
  importNativeSubjectPermissions(permissionsFor("agent", space,
    { owner: caller.owner, actor: caller.actor, connId: caller.actor, lifecycleUid: caller.uid },
    { ...opts, lifecycleUid: caller.uid, issued: { generation: caller.generation, acceptedToken: mintAcceptedToken() } }));

const over = (ceiling: IssuedSubjectPermissions, grant: DelegatedGrant) => grantOverreach(space, caller, ceiling, grant);
const names = (o: GrantOverreach[]) => o.map((x) => `${x.field}:${x.value}`).sort();
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

console.log("channels");
{
  const c = evidence({ allowSubscribe: ["review", "ops"], allowPublish: ["review"] });
  ok("a grant inside the spawner's channels is within", over(c, { allowSubscribe: ["review"], allowPublish: ["review"] }).length === 0);
  const o = names(over(c, { allowSubscribe: ["review"], allowPublish: ["review", "ops"] }));
  ok("posting where the spawner may only read is named", same(o, ["allowPublish:ops"]), o);
  const r = names(over(c, { allowSubscribe: ["general"] }));
  ok("reading a channel the spawner cannot read is named", same(r, ["allowSubscribe:general"]), r);
  const s = names(over(c, { subscribe: ["general"] }));
  ok("a subscribe-only grant is folded into the read ACL and bounded", same(s, ["allowSubscribe:general"]), s);
}

console.log("wildcards");
{
  const narrow = evidence({ allowSubscribe: ["review.pua"] });
  const o = names(over(narrow, { allowSubscribe: ["review.>"] }));
  ok("a wildcard wider than the spawner's concrete channel is refused", same(o, ["allowSubscribe:review.>"]), o);
  const wide = evidence({ allowSubscribe: ["review.>"], allowPublish: ["review.>"] });
  ok("a concrete channel under the spawner's wildcard is within", over(wide, { allowSubscribe: ["review.pua"], allowPublish: ["review.pua"] }).length === 0);
  const e = names(over(evidence({ allowSubscribe: ["review"] }), { allowSubscribe: ["events.>"] }));
  ok("an event-channel wildcard the spawner does not hold is refused", same(e, ["allowSubscribe:events.>"]), e);
}

console.log("role");
{
  const c = evidence({ role: "reviewer" });
  ok("the spawner's own role is within", over(c, { role: "reviewer" }).length === 0);
  const o = names(over(c, { role: "worker" }));
  ok("a role the spawner was not minted is refused", same(o, ["role:worker"]), o);
  ok("role:<r> as a capability token is held when the spawner holds that role", over(c, { capabilities: ["role:reviewer"] }).length === 0);
  const t = names(over(c, { capabilities: ["role:worker"] }));
  ok("role:<r> for another role is refused", same(t, ["capabilities:role:worker"]), t);
}

console.log("capabilities");
{
  const plain = evidence({});
  const o = names(over(plain, { capabilities: ["spawn"] }));
  ok("spawn from a spawner without it is refused", same(o, ["capabilities:spawn"]), o);
  ok("spawn from a spawn holder is within", over(evidence({ capabilities: ["spawn"] }), { capabilities: ["spawn"] }).length === 0);
  ok("spawn from a run holder is within (run carries the spawn set)", over(evidence({ capabilities: ["run"] }), { capabilities: ["spawn"] }).length === 0);
  const r = names(over(evidence({ capabilities: ["spawn"] }), { capabilities: ["run"] }));
  ok("run from a spawn-only holder is refused", same(r, ["capabilities:run"]), r);
  const a = names(over(evidence({ capabilities: ["spawn", "run"] }), { capabilities: ["admin"] }));
  ok("admin from a non-admin spawner is refused", same(a, ["capabilities:admin"]), a);
  const u = names(over(evidence({ capabilities: ["spawn"] }), { capabilities: ["superuser"] }));
  ok("an unknown token is refused, never read as an empty grant", same(u, ["capabilities:superuser"]), u);
}

console.log("endpoints");
{
  const INST = "inst0000000000000000000000a1";
  const c = evidence({ endpointCapabilities: [{ endpoint: "linear", command: "search" }] });
  ok("a command the spawner holds is within", over(c, { endpoints: [{ endpoint: "linear", commands: ["search"] }] }).length === 0);
  const o = names(over(c, { endpoints: [{ endpoint: "linear", commands: ["search", "update"] }] }));
  ok("a command the spawner lacks is named", same(o, ["endpoints:linear update"]), o);
  const p = names(over(c, { endpoints: [{ endpoint: "linear", commands: ["search"], instanceId: INST }] }));
  ok("an instance pin the spawner holds no rail for is refused", same(p, [`endpoints:linear search on ${INST}`]), p);
  const pinned = evidence({ endpointCapabilities: [{ endpoint: "linear", command: "search", instanceId: INST, instanceOnly: true }] });
  ok("the spawner's own instance pin is within", over(pinned, { endpoints: [{ endpoint: "linear", commands: ["search"], instanceId: INST }] }).length === 0);
  const q = names(over(pinned, { endpoints: [{ endpoint: "linear", commands: ["search"] }] }));
  ok("the class rail from an instance-pinned spawner is refused", same(q, ["endpoints:linear search"]), q);
}

console.log("ceiling modes");
{
  const all: IssuedSubjectPermissions = { publish: { allow: { mode: "all" }, deny: [] }, subscribe: { allow: { mode: "all" }, deny: [] } };
  ok("an unrestricted ceiling holds every known part", over(all, { allowSubscribe: ["x"], allowPublish: ["x"], role: "r", capabilities: ["spawn", "run", "admin"] }).length === 0);
  const none: IssuedSubjectPermissions = { publish: { allow: { mode: "none" }, deny: [] }, subscribe: { allow: { mode: "none" }, deny: [] } };
  const n = names(over(none, { allowSubscribe: ["x"], allowPublish: ["x"] }));
  ok("a none ceiling holds nothing", same(n, ["allowPublish:x", "allowSubscribe:x"]), n);
  const denied: IssuedSubjectPermissions = { publish: { allow: { mode: "all" }, deny: [`${spacePrefix(space)}.chat.>`] }, subscribe: { allow: { mode: "all" }, deny: [] } };
  const d = names(over(denied, { allowPublish: ["x"] }));
  ok("an overlapping deny refuses", same(d, ["allowPublish:x"]), d);
  ok("the empty grant is within any ceiling", over(none, {}).length === 0);
}

console.log("token rule (ledger)");
ok("spawn is within run", capabilityWithin(["run"], "spawn"));
ok("run is not within spawn", !capabilityWithin(["spawn"], "run"));
ok("role:<r> needs the same token", capabilityWithin(["role:a"], "role:a") && !capabilityWithin(["role:a"], "role:b"));
ok("an unknown token is never within, even when the parent lists it", !capabilityWithin(["superuser"], "superuser"));

console.log(`\nGRANT-BOUND SMOKE ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
