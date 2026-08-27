/**
 * Persona-ownership smoke — the acceptance gate for confining SPAWN to personas a caller owns.
 *
 * The manager has two persona doors. The WRITE door (`opDefinePersona`) has always been
 * owner-authorized: a peer may redefine a persona only if it owns it, and an OWNERLESS file
 * (legacy, or hand-written by the operator) is admin-only — fail-closed, because an ownerless file
 * is the operator's until proven otherwise. The SPAWN door applied nothing at all: it resolved the
 * name to a file, loaded it, and launched it for whoever asked. So the manager refused to let a
 * peer EDIT `deploy_runner` while handing that same persona to any caller that named it, and the
 * fail-closed stance was exactly inverted — operator-written personas are precisely the ones with
 * no `owner:`.
 *
 * The fix is one predicate applied at both doors, not a second copy at the new one. Two copies of
 * an authorization rule drift, and the drift is silent on the door nobody is looking at — so the
 * single-definition property is asserted here as a cell, not left to review.
 *
 * Isolation defaults to `shared` (the historical behaviour, byte-for-byte). A manager whose callers
 * are one operator — overwhelmingly the common case — must not begin refusing its own catalog on
 * upgrade, so the narrowing is opt-in by the deployment.
 *
 * Run: pnpm smoke:persona-ownership   (no broker; pure predicate + source-structure cells)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { personaOwnerDenial, personaDenialMessage } from "../src/manager.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const ALICE = "u_" + "a".repeat(26);
const BOB = "u_" + "b".repeat(26);

console.log("the predicate — who may act on a persona:");
check("its OWNER may act on it", personaOwnerDenial({ owner: ALICE }, ALICE, false) === undefined);
check("ANOTHER owner is refused, named 'not-owner'", personaOwnerDenial({ owner: ALICE }, BOB, false) === "not-owner");
// The inverted-fail-closed case: an operator's hand-written persona has no `owner:` at all, and is
// exactly the file a participant must not be able to launch.
check("an OWNERLESS (operator/legacy) file is refused, named 'ownerless'",
  personaOwnerDenial({}, ALICE, false) === "ownerless");
check("…and `owner: undefined` is the same as absent (not an accidental match)",
  personaOwnerDenial({ owner: undefined }, ALICE, false) === "ownerless");
check("an ADMIN may act on another's persona", personaOwnerDenial({ owner: ALICE }, BOB, true) === undefined);
check("an ADMIN may act on an ownerless one (the operator's own escape hatch)",
  personaOwnerDenial({}, BOB, true) === undefined);
// An empty caller is what a non-ctl path supplies; it must never satisfy an ownerless file.
check("an EMPTY caller never passes an ownerless file", personaOwnerDenial({}, "", false) === "ownerless");
check("an EMPTY caller never matches an owned file", personaOwnerDenial({ owner: ALICE }, "", false) === "not-owner");

console.log("\nthe refusal names whose it is, in the door's own vocabulary:");
check("a not-owner refusal names the OWNER",
  personaDenialMessage("not-owner", "spawn", "reviewer", ALICE).includes(ALICE));
check("an ownerless refusal says operator-owned, and names NO owner token",
  personaDenialMessage("ownerless", "spawn", "deploy_runner").includes("operator-owned") &&
  !personaDenialMessage("ownerless", "spawn", "deploy_runner").includes("u_"));
check("the verb is the door's, so one message serves both",
  personaDenialMessage("not-owner", "redefine", "x", ALICE).includes("redefine") &&
  personaDenialMessage("not-owner", "spawn", "x", ALICE).includes("spawn"));

console.log("\nONE definition, both doors — the anti-drift property:");
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "manager.ts"), "utf8");
// Both doors must CALL the predicate. Counted, not eyeballed: a door that stops calling it is the
// regression this cell exists to catch.
const calls = (src.match(/personaOwnerDenial\(/g) ?? []).length;
check("the predicate is CALLED at exactly two doors (write + spawn)", calls === 3, { found: calls, note: "1 definition + 2 call sites" });
// And nowhere OUTSIDE the predicate may the rule be re-implemented. That is the shape the original
// bug had: the comparison living at one door, invisible from the other. The predicate's own body is
// excised first — it is the definition, not a door — so this counts re-implementations only.
const defStart = src.indexOf("export function personaOwnerDenial(");
const defEnd = src.indexOf("\n}", defStart);
if (defStart < 0 || defEnd < 0) { fail++; console.log("  ✗ FAIL: could not locate the predicate body to excise"); }
const outsideDef = src.slice(0, defStart) + src.slice(defEnd);
const inlineOwnerCompare = (outsideDef.match(/\.owner\s*!==\s*(caller|spawner)/g) ?? []).length;
check("no door re-implements the ownership comparison inline", inlineOwnerCompare === 0, { found: inlineOwnerCompare });
// Positive control for that excision: the comparison MUST still be found inside the predicate, or
// the slice removed the wrong region and the cell above is measuring an empty universe.
check("…and the excised predicate really did contain it (instrument control)",
  /\.owner\s*!==\s*caller/.test(src.slice(defStart, defEnd)));
check("the spawn door is gated on the isolation setting", /personaIsolation === "owner"/.test(src));
check("the default is the historical `shared`", /opts\.personaIsolation \?\? "shared"/.test(src));

console.log(`\nPERSONA-OWNERSHIP SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
const EXPECTED = 16;
if (pass + fail !== EXPECTED) { console.log(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail}`); process.exitCode = 1; }
if (fail) process.exitCode = 1;
