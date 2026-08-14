/**
 * The six-row manager decision table, driven directly.
 *
 * WHY THESE CELLS ARE NOT LIVE. The claim function is the part an operator acts on, and it is pure,
 * so every row — including the ones a live broker makes expensive or racy to construct — is built
 * here deterministically. A cell that has to schedule a real wedge in order to check what the card
 * SAYS about a wedge is testing two things and proving neither; the live arms prove the PROBE
 * classifies the world correctly, and these prove the CLAIM is entitled by that classification.
 * Both are needed and neither substitutes for the other. What is NOT covered here is whether a real
 * wedged manager actually produces `no-responder` — that is the live suite's job and it is named as
 * such rather than implied by these greens.
 *
 * The load-bearing assertion is `startHint`: it is the only output that tells an operator to LAUNCH
 * something, and a hint offered over a manager that is merely unreachable is how a second stack gets
 * started against a live one. It is asserted as a PROPERTY over every combination below, not
 * case-by-case, so a new arm added later cannot quietly acquire one.
 *
 * Run: pnpm exec tsx bin/smoke/manager-claim.smoke.ts
 */
import { managerClaim, type LocalManagerEvidence, type ManagerHealth } from "../../implementations/cli/src/lib/manager-health.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

const SRC = "manager status @ nats://127.0.0.1:4222 (instance abc)";
const AT = 1_700_000_000_000;
const serving: ManagerHealth = {
  condition: "serving", source: SRC, observedAt: AT, rttMs: 12,
  report: { instanceId: "abc", runtime: "pty", agentCount: 3, uptimeMs: 60_000 },
};
const noResponder: ManagerHealth = { condition: "no-responder", detail: "no manager answered for instance abc within 3000ms", source: SRC, observedAt: AT, rttMs: 3000 };
const unreachable: ManagerHealth = { condition: "unreachable", detail: "connect ECONNREFUSED", source: SRC, observedAt: AT, rttMs: 5 };
const refused: ManagerHealth = { condition: "refused", detail: "not permitted", source: SRC, observedAt: AT, rttMs: 20 };
const unattributed: ManagerHealth = { condition: "unattributed", expected: "abc", replied: "zzz", source: SRC, observedAt: AT, rttMs: 15 };
const noIdentity: ManagerHealth = { condition: "no-identity", detail: "no persisted manager instance identity", source: "local records", observedAt: AT };
const noAuth: ManagerHealth = { condition: "no-auth", detail: "no caller credential could be built", source: SRC, observedAt: AT };
const malformed: ManagerHealth = { condition: "malformed-reply", detail: "no instanceId in the reply", source: SRC, observedAt: AT, rttMs: 18 };

const ALL_HEALTH: ManagerHealth[] = [serving, noResponder, unreachable, refused, unattributed, noIdentity, noAuth, malformed];
const ALL_LOCAL: LocalManagerEvidence[] = ["alive", "dead", "unknown", "absent", "unattributable"];

console.log("\nmanager-claim — the six-row decision table\n");

// ---- ROW 1: an attributed affirmative reply is the ONLY route to green ---------------------------
check("ROW1: an attributed status reply claims `serving`", managerClaim("alive", serving).claim === "serving");
check("ROW1: `serving` is the only claim that sets serving=true", managerClaim("alive", serving).serving === true);
check("ROW1: the serving detail carries the ATTRIBUTION (which instance answered)",
  managerClaim("alive", serving).detail.includes("instance abc"));
check("ROW1: the serving detail carries the round trip that produced it",
  managerClaim("alive", serving).detail.includes("12ms"));
check("ROW1: uptime is attributed to the RESPONDER's clock, not restated as a local time",
  managerClaim("alive", serving).detail.includes("by its own clock"));
// A reply is affirmative regardless of what the local pidfile says — including when this root has
// no record at all. Without this, a green would still be gated on local evidence it does not need.
check("ROW1: an answering manager is serving even with NO local pid record",
  managerClaim("absent", serving).claim === "serving");

// ---- ROW 2: pid alive + nothing answered = the WEDGE, the incident shape -------------------------
check("ROW2: a live local process with no reply is `wedged`, NOT serving",
  managerClaim("alive", noResponder).claim === "wedged");
check("ROW2: wedged is not green", managerClaim("alive", noResponder).serving === false);
check("ROW2: wedged offers NO start hint — a second manager would contend with the live one",
  managerClaim("alive", noResponder).startHint === false);
check("ROW2: wedged is NOT collapsed into `absent`", managerClaim("alive", noResponder).claim !== "absent");

// ---- ROW 3: broker unreachable does not implicate the manager -----------------------------------
for (const l of ALL_LOCAL)
  check(`ROW3: broker unreachable with local=${l} is \`cannot-establish\``, managerClaim(l, unreachable).claim === "cannot-establish");
check("ROW3: an unreachable broker never earns a start hint, even with no local process",
  managerClaim("absent", unreachable).startHint === false);
check("ROW3: the detail says the BROKER was unreachable, not that the manager is down",
  managerClaim("absent", unreachable).detail.includes("broker could not be reached"));

// ---- ROW 4: a refusal is an answer ---------------------------------------------------------------
check("ROW4: a refusal claims `refused`", managerClaim("alive", refused).claim === "refused");
check("ROW4: a refusal is NOT absence", managerClaim("absent", refused).claim !== "absent");
check("ROW4: a refusal earns no start hint — something is serving", managerClaim("absent", refused).startHint === false);

// ---- ROW 5: unknown / unattributable local evidence ---------------------------------------------
check("ROW5: local `unknown` with no reply is `cannot-establish`", managerClaim("unknown", noResponder).claim === "cannot-establish");
check("ROW5: local `unattributable` with no reply is `cannot-establish`", managerClaim("unattributable", noResponder).claim === "cannot-establish");
check("ROW5: neither earns a start hint — the record may front a process nobody can identify",
  managerClaim("unknown", noResponder).startHint === false && managerClaim("unattributable", noResponder).startHint === false);
check("ROW5: the two are told apart by their detail, not collapsed",
  managerClaim("unknown", noResponder).detail !== managerClaim("unattributable", noResponder).detail);

// ---- ROW 6: the ONLY earned start hint ------------------------------------------------------------
check("ROW6: dead local + no reply is `absent`", managerClaim("dead", noResponder).claim === "absent");
check("ROW6: absent local + no reply is `absent`", managerClaim("absent", noResponder).claim === "absent");
check("ROW6: THIS is where the start hint is earned", managerClaim("dead", noResponder).startHint === true);

// ---- MISATTRIBUTION: a sibling answered ----------------------------------------------------------
// This is the cell the PIN exists for, and nothing else covers it: the reply is affirmative and
// well-formed, and is about the wrong process.
check("PIN: a reply from another instance is `misattributed`", managerClaim("alive", unattributed).claim === "misattributed");
check("PIN: a sibling's affirmative reply is NOT serving", managerClaim("alive", unattributed).serving === false);
check("PIN: it is not absence either, so no start hint over a live sibling",
  managerClaim("absent", unattributed).claim !== "absent" && managerClaim("absent", unattributed).startHint === false);
check("PIN: the detail names BOTH ids so an operator can see the mismatch",
  managerClaim("alive", unattributed).detail.includes("zzz") && managerClaim("alive", unattributed).detail.includes("abc"));

// ---- COULD-NOT-ASK is distinct from NOTHING-ANSWERED ---------------------------------------------
check("no-auth is `cannot-establish`, not `absent` — nothing was asked", managerClaim("absent", noAuth).claim === "cannot-establish");
check("no-auth earns NO start hint", managerClaim("absent", noAuth).startHint === false);
check("malformed-reply is `cannot-establish`, not serving", managerClaim("alive", malformed).claim === "cannot-establish");
check("no-identity with no local process IS absent (nothing recorded, nothing answered)",
  managerClaim("absent", noIdentity).claim === "absent" && managerClaim("absent", noIdentity).startHint === true);
check("no-identity with a LIVE local process is not absent — a process exists we cannot address",
  managerClaim("alive", noIdentity).claim === "wedged");

// ---- PROPERTIES OVER THE WHOLE MATRIX ------------------------------------------------------------
// Asserted as properties rather than case-by-case, so an arm added later cannot quietly acquire a
// start hint or a green without one of these failing.
const matrix = ALL_LOCAL.flatMap((l) => ALL_HEALTH.map((h) => ({ l, h, r: managerClaim(l, h) })));
check(`MATRIX: every combination produces a claim (${matrix.length} combinations)`,
  matrix.length === 40 && matrix.every((m) => typeof m.r.claim === "string"));
// `.some()` over an empty set fails safely; `.every()` over an empty set passes vacuously — so the
// size is pinned above before any `.every()` below is trusted.
check("PROPERTY: serving=true ONLY when the health read was `serving`",
  matrix.every((m) => m.r.serving === (m.h.condition === "serving")));
check("PROPERTY: a start hint is offered ONLY when nothing answered AND no local process exists",
  matrix.every((m) => !m.r.startHint || ((m.h.condition === "no-responder" || m.h.condition === "no-identity") && (m.l === "dead" || m.l === "absent"))));
check("PROPERTY: nothing that is serving also offers a start hint",
  matrix.every((m) => !(m.r.serving && m.r.startHint)));
check("PROPERTY: every claim carries a non-empty detail — no bare condition names",
  matrix.every((m) => m.r.detail.length > 20));
// The inverse of the start-hint property: it must actually be reachable, or the rule above is
// satisfied by never offering one at all.
check("INVERSE: the start hint IS reachable (else the property above passes by never granting it)",
  matrix.some((m) => m.r.startHint));
check("INVERSE: `serving` IS reachable", matrix.some((m) => m.r.serving));
// Every claim in the union must be produced by some combination, or a row of the table is dead code
// that no cell would notice being wrong.
for (const claim of ["serving", "wedged", "absent", "refused", "misattributed", "cannot-establish"] as const)
  check(`REACHABLE: some combination produces \`${claim}\``, matrix.some((m) => m.r.claim === claim));

const EXPECTED_CELLS = 49;
if (pass + fail !== EXPECTED_CELLS) {
  fail++;
  console.log(`  ✗ FAIL: CELL COUNT: expected ${EXPECTED_CELLS} cells, ran ${pass + fail - 1}`);
}

console.log(`\nmanager-claim: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
