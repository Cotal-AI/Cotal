/**
 * OWN-AGENT CONTROL smoke — pins the pure named-target (stop/attach) authorization policy
 * ({@link authorizeNamedControl}) without a broker: the full matrix the live smokes exercise
 * end-to-end, plus the fail-closed edges that are awkward to stage live.
 *
 *   1. admin tier reaches any target (both modes);
 *   2. privileged tier: own child (spawner === caller) passes, both modes;
 *   3. static mesh: a non-spawner is denied with the admin-tier sentence (behavior unchanged);
 *   4. user mesh owner-domain: a caller under the TARGET'S OWNER passes even when it is not the
 *      spawner (the cli actor, a sibling agent) — and the ledger is NOT consulted for it;
 *   5. user mesh cross-owner: denied, naming the boundary + the ADD-to-current re-grant;
 *   6. user mesh cross-owner with a fresh ledger row carrying "admin": allowed;
 *   7. fail-closed: unparseable caller, target with no stored owner, ledger read throwing,
 *      and a scope WITHOUT "admin" — all deny.
 *
 * Run: pnpm smoke:own-agent-control
 */
import { authorizeLaunch, authorizeNamedControl } from "../src/authorize.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const OWNER_A = "u_" + "a".repeat(26);
const OWNER_B = "u_" + "b".repeat(26);
const target = { name: "worker", spawner: `${OWNER_A}.cli`, userOwner: OWNER_A };
const noScope = async () => undefined;
const neverCalled = async (): Promise<string[] | undefined> => {
  throw new Error("ledger must not be consulted on this row");
};

// 1. admin tier — any target, both modes.
check(
  "admin tier reaches any target (user mode)",
  (await authorizeNamedControl({ target, caller: `${OWNER_B}.cli`, admin: true, userMode: true, scopeOf: neverCalled })) === undefined,
);
check(
  "admin tier reaches any target (static mode)",
  (await authorizeNamedControl({ target: { name: "w", spawner: "local.X" }, caller: "local.Y", admin: true, userMode: false, scopeOf: neverCalled })) ===
    undefined,
);

// 2. own child on the privileged tier — both modes, ledger untouched.
check(
  "own child passes on the privileged tier (user mode)",
  (await authorizeNamedControl({ target, caller: `${OWNER_A}.cli`, admin: false, userMode: true, scopeOf: neverCalled })) === undefined,
);
check(
  "own child passes on the privileged tier (static mode)",
  (await authorizeNamedControl({ target: { name: "w", spawner: "local.X" }, caller: "local.X", admin: false, userMode: false, scopeOf: neverCalled })) ===
    undefined,
);

// 3. static mesh unchanged: non-spawner denied with the admin-tier sentence.
const staticDenied = await authorizeNamedControl({
  target: { name: "w", spawner: "local.X" },
  caller: "local.Y",
  admin: false,
  userMode: false,
  scopeOf: neverCalled,
});
check("static mesh: non-spawner is denied", typeof staticDenied === "string");
check("static denial names the admin tier (unchanged wording)", !!staticDenied?.includes("admin tier required"), staticDenied);

// 4. owner-domain: same owner, different actor — allowed WITHOUT a ledger read.
check(
  "owner-domain: a sibling actor under the target's owner passes",
  (await authorizeNamedControl({ target, caller: `${OWNER_A}.helper`, admin: false, userMode: true, scopeOf: neverCalled })) === undefined,
);

// 5. cross-owner: denied, boundary + ADD-to-current re-grant named.
const crossDenied = await authorizeNamedControl({ target, caller: `${OWNER_B}.cli`, admin: false, userMode: true, scopeOf: noScope });
check("cross-owner without admin is denied", typeof crossDenied === "string");
check("…naming the owner boundary", !!crossDenied?.includes("another owner"), crossDenied);
check('…and the ADD-to-current re-grant (never a bare --scope admin)', !!crossDenied?.includes("ADDED") && !!crossDenied?.includes("cotal actor list"), crossDenied);

// 6. cross-owner with a fresh ledger "admin" row: allowed (and the read is keyed on the CALLER).
let asked: string | undefined;
const adminLedger = async (owner: string, actor: string) => {
  asked = `${owner}.${actor}`;
  return ["spawn", "role:default", "admin"];
};
check(
  "cross-owner with ledger admin passes",
  (await authorizeNamedControl({ target, caller: `${OWNER_B}.cli`, admin: false, userMode: true, scopeOf: adminLedger })) === undefined,
);
check("the ledger read is keyed on the CALLER principal", asked === `${OWNER_B}.cli`, asked);

// 7. fail-closed edges.
check(
  "a scope without admin denies",
  typeof (await authorizeNamedControl({ target, caller: `${OWNER_B}.cli`, admin: false, userMode: true, scopeOf: async () => ["spawn", "role:default"] })) ===
    "string",
);
check(
  "a throwing ledger read denies (unreadable ledger authorizes nothing)",
  typeof (await authorizeNamedControl({ target, caller: `${OWNER_B}.cli`, admin: false, userMode: true, scopeOf: neverCalled })) === "string",
);
check(
  "an unparseable caller denies",
  typeof (await authorizeNamedControl({ target, caller: "not-a-principal", admin: false, userMode: true, scopeOf: noScope })) === "string",
);
check(
  "a target with no stored owner never matches owner-domain",
  typeof (await authorizeNamedControl({
    target: { name: "w", spawner: `${OWNER_A}.cli` },
    caller: `${OWNER_A}.helper`,
    admin: false,
    userMode: true,
    scopeOf: noScope,
  })) === "string",
);

// 8. authorizeLaunch — the user-mesh manifest-deploy policy (pure; the static privileged-tier
//    reject lives in the dispatch, and the live deploy path is covered by user-auth-launch).
check(
  "launch: admin tier passes regardless of owners",
  authorizeLaunch({ specOwner: OWNER_A, caller: `${OWNER_B}.cli`, admin: true, runId: "r1" }) === undefined,
);
check(
  "launch: own-owner spec passes on the privileged tier",
  authorizeLaunch({ specOwner: OWNER_A, caller: `${OWNER_A}.cli`, admin: false, runId: "r1" }) === undefined,
);
const launchCross = authorizeLaunch({ specOwner: OWNER_A, caller: `${OWNER_B}.cli`, admin: false, runId: "r1" });
check("launch: cross-owner spec is denied", typeof launchCross === "string");
check("…naming the owner boundary + the ADD-to-current re-grant", !!launchCross?.includes("another owner") && !!launchCross?.includes("ADDED"), launchCross);
check(
  "launch: an ownerless spec never matches (fail-closed)",
  typeof authorizeLaunch({ specOwner: undefined, caller: `${OWNER_A}.cli`, admin: false, runId: "r1" }) === "string",
);
check(
  "launch: an unparseable caller is denied (fail-closed)",
  typeof authorizeLaunch({ specOwner: OWNER_A, caller: "not-a-principal", admin: false, runId: "r1" }) === "string",
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nown-agent-control smoke: all checks passed");
