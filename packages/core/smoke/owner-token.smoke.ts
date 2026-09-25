/**
 * Owner/actor token smoke (per-user-auth prep): owner+actor serialization must be fail-loud and
 * collision-free before the subject grammar flips.
 *
 * Run: pnpm smoke:owner-token
 */
import {
  assertValidOwnerToken, principalNameKey, principalSubjectKey,
  runDriverCaller, runDriverGrants, runMediatorGrants, epCallerReplyFilter, epRequestGrantRows,
} from "../src/index.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

check("plain alnum owner token is accepted", assertValidOwnerToken("Owner123") === "Owner123");
check("underscore owner token is accepted", assertValidOwnerToken("owner_actor") === "owner_actor");
check("dot is rejected", throws(() => assertValidOwnerToken("owner.actor")));
check("wildcard star is rejected", throws(() => assertValidOwnerToken("owner*")));
check("wildcard greater-than is rejected", throws(() => assertValidOwnerToken("owner>")));
check("hyphen is rejected because it is the JetStream-name separator", throws(() => assertValidOwnerToken("owner-actor")));
check("empty token is rejected", throws(() => assertValidOwnerToken("")));
check("non-ASCII token is rejected", throws(() => assertValidOwnerToken("café")));

check("subject/KV principal key uses dot separator", principalSubjectKey("owner_1", "actor_2") === "owner_1.actor_2");
check("JetStream principal key uses hyphen separator", principalNameKey("owner_1", "actor_2") === "owner_1-actor_2");
check("hyphen ban prevents ambiguous name-key owner side", throws(() => principalNameKey("owner-1", "actor")));
check("hyphen ban prevents ambiguous name-key actor side", throws(() => principalNameKey("owner", "actor-1")));

const runId = "run-owner";
const staticCaller = { owner: "local", actor: "wf_0f9833db0c09", uid: "61d5746a4069b01ba0edc7feeb" };
const ownerA = `u_${"a".repeat(26)}`;
const ownerB = `u_${"b".repeat(26)}`;
const callerA = runDriverCaller(runId, ownerA);
check("run caller preserves the static identity", JSON.stringify(runDriverCaller(runId)) === JSON.stringify(staticCaller));
check("run caller preserves the explicit local identity", JSON.stringify(runDriverCaller(runId, "local")) === JSON.stringify(staticCaller));
check("run caller keeps the admitted owner", callerA.owner === ownerA);
check("run caller keeps run-derived actor and lifecycle", callerA.actor === staticCaller.actor && callerA.uid === staticCaller.uid);
check("run caller separates owners on the same run id", runDriverCaller(runId, ownerB).owner === ownerB && callerA.owner !== ownerB);
check("run caller refuses arbitrary owner tokens", throws(() => runDriverCaller(runId, "other_owner")));
check("run caller refuses a legacy nkey owner", throws(() => runDriverCaller(runId, `U${"A".repeat(55)}`)));
check("run caller refuses a wildcard owner", throws(() => runDriverCaller(runId, "*")));
check("run caller refuses an invalid run id", throws(() => runDriverCaller("run.*", ownerA)));

const pin = { endpoint: "manager", runId, takeoverId: "takeover", instanceId: "i".repeat(26), epoch: 1 };
const connId = "U" + "A".repeat(55);
const staticGrants = runMediatorGrants("ownercheck", pin, connId);
const ownerGrants = runMediatorGrants("ownercheck", { ...pin, owner: ownerA }, connId);
check("run mediator preserves omitted-owner static grants",
  JSON.stringify(staticGrants) === JSON.stringify(runMediatorGrants("ownercheck", { ...pin, owner: "local" }, connId)));
check("run mediator replies to the admitted owner",
  ownerGrants.subscribe.includes(epCallerReplyFilter("ownercheck", callerA)) &&
  !ownerGrants.subscribe.includes(epCallerReplyFilter("ownercheck", staticCaller)));
check("run mediator lifecycle calls target the admitted owner",
  ["turn", "despawn"].every(command => epRequestGrantRows("ownercheck", {
    endpoint: "manager", command, target: { mode: "owner", tOwner: ownerA },
  }, callerA).every(row => ownerGrants.publish.includes(row))));
check("run mediator refuses an invalid owner", throws(() => runMediatorGrants("ownercheck", { ...pin, owner: "*" }, connId)));
check("run driver grants stay confined when owner is supplied",
  JSON.stringify(runDriverGrants("ownercheck", pin, connId)) ===
  JSON.stringify(runDriverGrants("ownercheck", { ...pin, owner: ownerA }, connId)));
check("run driver rejects an invalid supplied owner", throws(() => runDriverGrants("ownercheck", { ...pin, owner: "*" }, connId)));
check("owner token check count", pass + fail === 27);

if (fail) {
  console.error(`\nOWNER TOKEN SMOKE FAILED (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`\nOWNER TOKEN SMOKE PASSED ✅  (${pass} checks)`);
