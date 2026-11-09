/** The delegation bound: a grant is tested against the spawner's evidence at the spawner's own
 *  coordinate, and each part it does not hold is named. Each ceiling here is the evidence an agent
 *  mint records (provision.ts imports the minted permissions verbatim). No broker. */
import { createSpaceAuth, mintCreds, permissionsFor, type MintOpts } from "../src/provision.js";
import { mintLifecycleUid, newIdentity } from "../src/index.js";
import type { IssuanceSeam } from "../src/issued-authority.js";
import { importNativeSubjectPermissions, mintAcceptedToken, mintGeneration, type IssuedEvidence, type IssuedSubjectPermissions } from "../src/issued-authority.js";
import { capabilityWithin, grantOverreach, grantParts, issuedSpawnerStanding, type DelegatedGrant, type GrantOverreach } from "../src/grant-bound.js";
import type { IssuedCaller } from "../src/endpoint-subjects.js";
import { instanceOnlyManagerCapabilities, operatorInstrumentCapabilities, runCallerCapabilities, type EpCapability } from "../src/endpoint-grants.js";
import { DEV_OWNER, spacePrefix } from "../src/subjects.js";
import { lowerPersonaEndpoints } from "../src/persona-endpoints.js";

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
  const tokened = evidence({ capabilities: ["role:worker"] });
  ok("a spawner minted the role:<r> token hands that role on", over(tokened, { role: "worker" }).length === 0);
  ok("and the token itself", over(tokened, { capabilities: ["role:worker"] }).length === 0);
  const o2 = names(over(tokened, { role: "reviewer" }));
  ok("but no other role", same(o2, ["role:reviewer"]), o2);
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

console.log("parts (no evidence)");
{
  const p = names(grantParts({ subscribe: ["review"], allowPublish: ["ops"], role: "worker", capabilities: ["spawn", "superuser"] }));
  ok("every part of a grant is named, an unknown token included", same(p, ["allowPublish:ops", "allowSubscribe:review", "capabilities:spawn", "capabilities:superuser", "role:worker"]), p);
  ok("an empty grant has no parts", grantParts({}).length === 0);
}

console.log("standing (static spawner)");
{
  const mint = (profile: "agent" | "control-caller-privileged" | "control-caller-admin" | "deployer", opts: Omit<MintOpts, "lifecycleUid" | "issued"> = {}) =>
    importNativeSubjectPermissions(permissionsFor(profile, space,
      { owner: caller.owner, actor: caller.actor, connId: caller.actor, lifecycleUid: caller.uid },
      { ...opts, lifecycleUid: caller.uid, issued: { generation: caller.generation, acceptedToken: mintAcceptedToken() } }));
  const source = { space, bucket: "cotal_static_lifecycle_gb", key: "slot.x" };
  const ev = (permissions: IssuedSubjectPermissions, sourced: boolean): IssuedEvidence => ({
    version: 1,
    ref: { space, owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: caller.generation },
    sources: sourced ? [source] : [],
    permissions,
    ...(sourced ? {} : { expiresAt: Math.floor(Date.now() / 1000) + 300 }),
  });
  ok("the privileged instrument is an instrument", issuedSpawnerStanding(ev(mint("control-caller-privileged"), false)) === "instrument");
  ok("the admin instrument is an instrument", issuedSpawnerStanding(ev(mint("control-caller-admin"), false)) === "instrument");
  ok("a source-free deployer is an instrument", issuedSpawnerStanding(ev(mint("deployer"), false)) === "instrument");
  ok("a source-free agent (fixed expiry) stays bounded: it holds its own presence key", issuedSpawnerStanding(ev(mint("agent", { allowSubscribe: ["review"] }), false)) === "bounded");
  ok("a managed agent is bounded", issuedSpawnerStanding(ev(mint("agent", { capabilities: ["spawn"] }), true)) === "bounded");
  ok("an agent holding the admin set is admin", issuedSpawnerStanding(ev(mint("agent", { capabilities: ["admin"] }), true)) === "admin");
  ok("a sourced instrument shape is not an instrument", issuedSpawnerStanding(ev(mint("control-caller-privileged"), true)) === "bounded");
  const mcPerms = importNativeSubjectPermissions(permissionsFor("manager-caller", space,
    { owner: caller.owner, actor: caller.actor, connId: caller.actor, lifecycleUid: caller.uid },
    { lifecycleUid: caller.uid, managerInstanceId: "inst0000000000000000000000a1", capabilities: ["spawn"], issued: { generation: caller.generation, acceptedToken: mintAcceptedToken() } }));
  ok("a sourced manager-caller is bounded, never an instrument", issuedSpawnerStanding(ev(mcPerms, true)) === "bounded");
}

console.log("issuer invariant");
{
  // A fake evidence store whose stage (an issue) and confirm (a renewal) stop the mint, so no broker
  // is needed.
  const STAGED = "staged: the issuer reached the evidence store";
  const auth = await createSpaceAuth(space);
  const issueSourceFree = async (profile: "agent" | "control-caller-privileged" | "manager-caller", extra: Omit<MintOpts, "lifecycleUid" | "issued" | "issuance" | "expiresAt"> = {}, mode: "issue" | "renew" = "issue") => {
    const now = Math.floor(Date.now() / 1000);
    const seam = { mode, sources: [], accepted: {}, store: { stage: async () => { throw new Error(STAGED); }, confirm: async () => { throw new Error(STAGED); } } } as unknown as IssuanceSeam;
    try {
      await mintCreds(auth, newIdentity(), profile, { ...extra, lifecycleUid: mintLifecycleUid(), expiresAt: now + 300,
        issued: { generation: mintGeneration(now + 3600), acceptedToken: mintAcceptedToken() }, issuance: seam });
      return "minted";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  ok("a source-free instrument reaches the evidence store", (await issueSourceFree("control-caller-privileged")) === STAGED);
  ok("a source-free agent reaches it too: it carries its own presence key", (await issueSourceFree("agent")) === STAGED);
  const mc = await issueSourceFree("manager-caller", { managerInstanceId: "inst0000000000000000000000a1" });
  ok("a source-free non-instrument with no presence key of its own is refused before staging", /must carry its own presence key/.test(mc), mc);
  // For third-party endpoints, an issued static agent credential carries only untargeted,
  // unjournaled commands: the static terminal has no obligation drain (SPEC 13.1). Refused on the
  // spawn's issue and on a renewal, before anything reaches the evidence store.
  const targeted: EpCapability = { endpoint: "com.example.orders", command: "cancel-order", target: { mode: "self" } };
  const journaled: EpCapability = { endpoint: "com.example.orders", command: "import", journal: true };
  for (const mode of ["issue", "renew"] as const) {
    const t = await issueSourceFree("agent", { endpointCapabilities: [targeted] }, mode);
    ok(`an issued agent ${mode} with a targeted endpoint command is refused before staging`, /for third-party endpoints, an issued static agent credential carries only untargeted, unjournaled commands; "com\.example\.orders cancel-order" is targeted/.test(t), t);
    const j = await issueSourceFree("agent", { endpointCapabilities: [journaled] }, mode);
    ok(`an issued agent ${mode} with a journaled endpoint command is refused before staging`, /"com\.example\.orders import" is journaled/.test(j), j);
  }
  ok("an issued agent with an untargeted command still reaches the evidence store",
    (await issueSourceFree("agent", { endpointCapabilities: [{ endpoint: "com.example.orders", command: "list" }] })) === STAGED);
  ok("an issued agent holding spawn, whose manager rows are targeted, still reaches the evidence store",
    (await issueSourceFree("agent", { capabilities: ["spawn"] })) === STAGED);
  // The manager's own targeted rows, passed as endpoint capabilities pinned to one instance, are the
  // rows the run and admin capabilities mint; the reference endpoint is outside the guard. A
  // third-party command beside them is still refused.
  const pinnedManager = instanceOnlyManagerCapabilities([{ endpoint: "manager", command: "describe" },
    ...runCallerCapabilities(DEV_OWNER), ...operatorInstrumentCapabilities("admin", DEV_OWNER)], "inst0000000000000000000000a1");
  ok("the pinned manager rows include a targeted command", pinnedManager.some((c) => c.target !== undefined), pinnedManager.map((c) => c.command));
  for (const mode of ["issue", "renew"] as const) {
    const m = await issueSourceFree("agent", { endpointCapabilities: pinnedManager }, mode);
    ok(`an issued agent ${mode} holding the manager's targeted rows pinned to one instance reaches the evidence store`, m === STAGED, m);
    const mixed = await issueSourceFree("agent", { endpointCapabilities: [...pinnedManager, targeted] }, mode);
    ok(`an issued agent ${mode} with those rows and a targeted third-party command is refused on the third-party command`, /"com\.example\.orders cancel-order" is targeted/.test(mixed), mixed);
  }
  let unissued = "minted";
  try { await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid(), endpointCapabilities: [targeted], expiresInSeconds: 300 }); }
  catch (e) { unissued = (e as Error).message; }
  ok("an unissued operator mint is not this guard's to refuse", unissued === "minted", unissued);
}

console.log("endpoints");
{
  const orders = (command: string, more: Partial<EpCapability> = {}): EpCapability => ({ endpoint: "com.example.orders", command, ...more });
  const held = evidence({ endpointCapabilities: [orders("list"), orders("create")] });
  ok("a command the spawner holds is within", over(held, { endpoints: [orders("list")] }).length === 0);
  const o = names(over(held, { endpoints: [orders("list"), orders("refund")] }));
  ok("a command the spawner does not hold is named, and only that one", same(o, ["endpoints:com.example.orders refund"]), o);
  const other = names(over(held, { endpoints: [{ endpoint: "com.example.billing", command: "list" }] }));
  ok("the same command on another endpoint is not held", same(other, ["endpoints:com.example.billing list"]), other);
  const none = names(over(evidence({}), { endpoints: [orders("list")] }));
  ok("a spawner with no endpoint rows holds none", same(none, ["endpoints:com.example.orders list"]), none);
  ok("an endpoint-only grant from a spawner with no evidence names the command", same(names(grantParts({ endpoints: [orders("list")] })), ["endpoints:com.example.orders list"]));
  // Class and instance rails are different subjects: a class grant never covers an instance pin, and
  // one instance never covers another.
  const pinA = orders("list", { instanceId: "ia000000000000000000000000a", instanceOnly: true });
  const pinB = orders("list", { instanceId: "ib000000000000000000000000b", instanceOnly: true });
  ok("a class grant does not cover an instance-pinned command", over(held, { endpoints: [pinA] }).length === 1);
  const heldA = evidence({ endpointCapabilities: [pinA] });
  ok("the same instance pin is within", over(heldA, { endpoints: [pinA] }).length === 0);
  ok("instance A does not cover instance B", over(heldA, { endpoints: [pinB] }).length === 1);
  ok("instance A does not cover the class rail", over(heldA, { endpoints: [orders("list")] }).length === 1);
  // A third-party command named spawn adds the caller's own goal-progress read; it is measured too.
  const spawnCmd = orders("spawn");
  const progressRow = (perms: IssuedSubjectPermissions) => JSON.stringify(perms.subscribe).includes(".goal.");
  ok("a third-party spawn command adds a goal-progress read to the mint", progressRow(evidence({ endpointCapabilities: [spawnCmd] })) && !progressRow(evidence({})));
  ok("a spawner holding that spawn command hands it on", over(evidence({ endpointCapabilities: [spawnCmd] }), { endpoints: [spawnCmd] }).length === 0);
  const spawnOver = names(over(held, { endpoints: [spawnCmd] }));
  ok("a spawner without it is refused, progress read included", same(spawnOver, ["endpoints:com.example.orders spawn"]), spawnOver);
  // A baseline command adds no row, so it cannot be shown to be held, and is refused.
  const baseline = names(over(evidence({}), { endpoints: [{ endpoint: "delivery", command: "join" }] }));
  ok("a command the baseline already grants adds no row and is refused", same(baseline, ["endpoints:delivery join"]), baseline);

  // A pinned persona entry, as the persona field lowers it: the instance rail only, plus that
  // instance's describe, each measured as its own part.
  const A = "ia000000000000000000000000a", B = "ib000000000000000000000000b";
  const pinnedA = lowerPersonaEndpoints([{ endpoint: "com.example.orders", commands: ["list"], instanceId: A }]);
  ok("a pinned entry lowers to the instance command and the instance describe, both instance-only",
    same(pinnedA.map((c) => `${c.command}@${c.instanceId}:${c.instanceOnly === true}`).sort(), [`describe@${A}:true`, `list@${A}:true`]), pinnedA);
  const minted = evidence({ endpointCapabilities: pinnedA });
  const prefix = `${spacePrefix(space)}.ep.v1`;
  const pub = minted.publish.allow.mode === "patterns" ? minted.publish.allow.patterns : [];
  ok("a pinned entry's credential has no class row for its command or its describe",
    !pub.some((r) => r.startsWith(`${prefix}.one.com_example_orders.`)) && pub.some((r) => r.startsWith(`${prefix}.inst.com_example_orders.${A}.list.`)) && pub.some((r) => r.startsWith(`${prefix}.inst.com_example_orders.${A}.describe.`)),
    pub.filter((r) => r.includes("com_example_orders")));
  ok("a spawner holding the pinned entry hands it on", over(minted, { endpoints: pinnedA }).length === 0);
  const partial = names(over(evidence({ endpointCapabilities: [pinA] }), { endpoints: pinnedA }));
  ok("a spawner with the instance command but not the instance describe is refused on the describe part",
    same(partial, [`endpoints:com.example.orders describe on instance ${A}`]), partial);
  const classOnly = names(over(held, { endpoints: pinnedA }));
  ok("a class grant covers neither part of a pinned entry", same(classOnly, [`endpoints:com.example.orders describe on instance ${A}`, `endpoints:com.example.orders list on instance ${A}`]), classOnly);
  const otherInstance = names(over(minted, { endpoints: lowerPersonaEndpoints([{ endpoint: "com.example.orders", commands: ["list"], instanceId: B }]) }));
  ok("a pin on instance A covers neither part of the same entry on instance B", same(otherInstance, [`endpoints:com.example.orders describe on instance ${B}`, `endpoints:com.example.orders list on instance ${B}`]), otherInstance);
}

console.log("token rule (ledger)");
ok("spawn is within run", capabilityWithin(["run"], "spawn"));
ok("run is not within spawn", !capabilityWithin(["spawn"], "run"));
ok("role:<r> needs the same token", capabilityWithin(["role:a"], "role:a") && !capabilityWithin(["role:a"], "role:b"));
ok("a token the parent lists is within, the ledger's open vocabulary included", capabilityWithin(["supervise"], "supervise"));
ok("a token the parent does not list is not within", !capabilityWithin(["spawn"], "supervise"));

console.log(`\nGRANT-BOUND SMOKE ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
