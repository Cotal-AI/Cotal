/**
 * B6: who may address a SPECIFIC instance (`--on`), and who may not.
 *
 * `epRequestGrantRows` emits the instance form `ep.inst.<endpoint>.<instanceId>.<command>…` ONLY when
 * a capability carries `instanceId` (`endpoint-grants.ts:62-70`). No profile sets it:
 * `operatorInstrumentCapabilities` builds `one`/`all` routes and nothing else, while its own comment
 * at the `ps` route decision already names the missing case - *"the other reads stay `one`-only
 * (anycast, or `inst` when a resolve pins `--on`)"*. So `--on` is dead on any authed mesh by
 * construction, and green on an open one because there is nothing to enforce.
 *
 * THIS SUITE IS TWO-ARMED ON PURPOSE AND THE SECOND ARM IS THE POINT. Issuing the capability makes
 * the ALLOWED arm pass trivially; a mint that hands the instance route to everybody passes it just
 * as well and is a security regression rather than a fix. So both directions are measured in ONE
 * run, over the same profiles, from the same builder:
 *
 *   OPERATOR INSTRUMENTS   should reach an instance route once the capability is issued.
 *   ORDINARY PRINCIPALS    must NEVER hold an instance row, before or after. An agent, including a
 *                          `spawn`-capable one, is not an operator.
 *
 * TODAY BOTH ARMS READ "NO INSTANCE ROW", which is the defect: the denied arm is already correct and
 * the allowed arm is the red. That asymmetry is deliberate - the denied arm is written FIRST and must
 * stay green through the fix, so it cannot be softened by the allowed arm's momentum afterwards.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. These are the rows a credential is MINTED with, read from
 * the shipped builder. A row is what the broker enforces on, but a minted row is not an observed
 * refusal: the enforcement arm (publish an instance-route request under each credential against a
 * real broker and read its verdict) is owed separately and is NOT in here. Acceptance is not
 * "everything is allowed", it is that the two arms DISAGREE in the right direction.
 *
 * Hermetic - no broker. Run: pnpm smoke:inst-route-grant
 */
import { strict as assert } from "node:assert";
import { permissionsFor, principalKey, DEV_OWNER, BASELINE_LIFECYCLE_ENDPOINT, type Profile } from "../src/index.js";

const SPACE = "instroute";
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const principal = (actor: string, lifecycleUid?: string) => ({
  owner: DEV_OWNER,
  actor,
  // Called directly rather than through `mintCreds`, so nothing builds the principal for us:
  // `instrumentEpRows` reads `pr.lifecycleUid` and fails loud without it (the ep reply rail is
  // lifecycle-keyed, SPEC 13.1/13.2).
  ...(lifecycleUid ? { lifecycleUid } : {}),
  // The inbox guard demands [A-Za-z0-9_-]{8,120}; a short actor name derives a connId under the
  // floor and throws before any row is built, which reads as a profile failure rather than a
  // fixture one. Suffix rather than truncate, so each actor still gets a distinct inbox.
  connId: `conn${principalKey(DEV_OWNER, actor).key.replace(/[^A-Za-z0-9]/g, "")}0000`,
});

/** Every publish row a profile is minted with. */
const rowsFor = (profile: Profile, actor: string, opts: Record<string, unknown> = {}): string[] => {
  const perms = permissionsFor(profile, SPACE, principal(actor, opts.lifecycleUid as string | undefined) as never, opts as never) as {
    pub?: { allow?: string[] };
  };
  return perms.pub?.allow ?? [];
};

const instRows = (rows: string[]) => rows.filter((r) => r.includes(`.ep.inst.`));
const ordinaryRows = (rows: string[]) => rows.filter((r) => /\.ep\.(one|all)\./.test(r));

// The profiles the `--on` route matters for, and the ones it must never reach. Names come from the
// shipped `Profile` union, so a renamed profile fails to compile rather than silently dropping an arm.
// The ep-CALLER profiles, which are not the same set as "the privileged profiles". `operator`,
// `admin` and `deployer` hold no ordinary ep request rows at all, so measuring "no instance row" on
// them would be vacuous - CELL 1 caught exactly that and refused to let this suite pretend
// otherwise. These three are the ones whose rows come from operatorInstrumentCapabilities.
const OPERATOR: Array<{ profile: Profile; actor: string; opts?: Record<string, unknown> }> = [
  { profile: "control-caller-privileged", actor: "ccp", opts: { lifecycleUid: "aa11bb22cc33dd44ee55ff6677" } },
  { profile: "control-caller-admin", actor: "cca", opts: { lifecycleUid: "bb11cc22dd33ee44ff5566aa77" } },
];
const ORDINARY: Array<{ profile: Profile; actor: string; opts?: Record<string, unknown> }> = [
  { profile: "agent", actor: "plain", opts: { lifecycleUid: "cc11dd22ee33ff4455aa66bb77" } },
  { profile: "agent", actor: "spawner", opts: { lifecycleUid: "dd11ee22ff33aa4455bb66cc77", capabilities: ["spawn"] } },
  { profile: "observer", actor: "obs", opts: { lifecycleUid: "ee11ff22aa33bb4455cc66dd77" } },
];

console.log("CELL 1 - CONTROL: every profile under test can reach an ORDINARY route");
// Without this the denied arm below is uninformative: a profile with NO ep rows at all would
// "correctly" lack an instance row while proving nothing about instance addressing.
for (const p of [...OPERATOR, ...ORDINARY]) {
  const rows = rowsFor(p.profile, p.actor, p.opts);
  const ordinary = ordinaryRows(rows);
  if (p.profile === "observer") {
    // An observer legitimately holds no request rows; it is here to keep the sweep honest about who
    // is in it, not as an ep caller. Recorded rather than asserted either way.
    console.log(`    (observer holds ${ordinary.length} ordinary ep rows - not an ep caller)`);
    continue;
  }
  check(`${p.profile}/${p.actor} holds at least one ordinary ep route`, ordinary.length > 0, {
    endpoint: BASELINE_LIFECYCLE_ENDPOINT, count: ordinary.length,
  });
}

console.log("\nCELL 2 - DENIED ARM (written first, must stay green through the fix)");
for (const p of ORDINARY) {
  const rows = instRows(rowsFor(p.profile, p.actor, p.opts));
  check(`${p.profile}/${p.actor} holds NO instance route`, rows.length === 0, rows.slice(0, 3));
}

console.log("\nCELL 3 - ALLOWED ARM (the B6 defect: RED until the capability is issued)");
const operatorInst = OPERATOR.map((p) => ({ who: `${p.profile}/${p.actor}`, n: instRows(rowsFor(p.profile, p.actor, p.opts)).length }));
console.log(`    measured: ${operatorInst.map((o) => `${o.who}=${o.n}`).join("  ")}`);
check("at least one operator instrument can address a specific instance",
  operatorInst.some((o) => o.n > 0), operatorInst);

console.log(`\ninst-route-grant: ${pass} checks passed`);
