/**
 * Spawn names must be mintable identities — the auto-numbering and the name door agree.
 *
 * THE DEFECT THIS PINS. In user mode the allocated agent name IS the mesh actor
 * (`agentTriple.actor = name`). `assertValidOwnerToken` rejects `-`, because `-` is the sole
 * separator of `principalKey`'s JetStream-name form. The auto-numbering scheme appended its
 * counter with `-`. So the SECOND live instance of any persona was named `<base>-2` and could
 * never be granted: spawn a teammate twice and the second one is refused at mint.
 *
 * Why it survived. Static/open mode keys the actor on the freshly minted nkey rather than on the
 * name, so every local and CI mesh numbered up happily. The defect fires only where per-user auth
 * is on — which is every hosted mesh, and only the second spawn onward, so the first spawn of a
 * fresh persona always works and the failure looks like a problem with that one persona's name.
 *
 * WHAT THIS SUITE MEASURES. Not a restatement of the alphabet — the cells COMPOSE the two shipped
 * functions in the same order the manager composes them, and hand the numbering's own output to
 * the real validator. If either side's alphabet changes, this reddens without being edited.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { firstFreeName, spawnNameError } from "../src/agent-file.js";
import { assertValidOwnerToken } from "../src/subjects.js";

let passed = 0;
let failed = 0;
function check(what: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${what}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
const mintable = (n: string) => {
  try {
    assertValidOwnerToken(n);
    return true;
  } catch {
    return false;
  }
};

console.log("\nspawn name ⇄ actor token");

// INSTRUMENT CONTROL. If the validator accepted everything, every cell below would pass for free.
check("instrument control: the validator ACCEPTS a plain base name", mintable("reviewer"));
check("instrument control: the validator REJECTS a hyphenated name", !mintable("reviewer-2"));

// The numbering is a no-op when the base is free — the common path is untouched.
check("a free base is returned unchanged", firstFreeName("reviewer", () => false) === "reviewer");

// THE DEFECT. Walk a real collision series and hand every name the numbering produces to the real
// validator. Asserting the COUNT as well as the absence of failures: a loop that examined nothing
// would otherwise report the same green as one that proved all of them.
const SERIES = 12;
const taken = new Set<string>(["reviewer"]);
const produced: string[] = [];
for (let i = 0; i < SERIES; i++) {
  const next = firstFreeName("reviewer", (n) => taken.has(n));
  produced.push(next);
  taken.add(next);
}
const unmintable = produced.filter((n) => !mintable(n));

// VACUITY CONTROL, and it is load-bearing rather than decorative. Every claim below is UNIVERSAL
// over `produced` — "every name is mintable", "all distinct", "the door accepts every one" — and a
// universal claim over an empty set is true. Measured: with the series emptied, 19 of these 20
// cells still passed. So the floor is asserted against a literal, not against SERIES: comparing a
// count to the same variable that produced it is satisfied at zero and proves nothing.
check(`instrument control: the collision series is NON-EMPTY (${produced.length} names)`,
  produced.length >= 10 && produced.length === SERIES, { produced });
check(
  `every name the numbering produces is a mintable actor (checked ${produced.length})`,
  produced.length >= 10 && produced.length === SERIES && unmintable.length === 0,
  { produced, unmintable },
);
check("…and they are all distinct, so the series still resolves collisions",
  produced.length >= 10 && new Set(produced).size === SERIES);
check("…and the second instance is the one that used to be unmintable", produced[0] === "reviewer_2", {
  second: produced[0],
});

// The same composition through the door the manager actually calls, in the mode that constrains it.
const producedRejected = produced.filter((n) => spawnNameError(n, { userMode: true }) !== undefined);
check(
  `the user-mode name door ACCEPTS every name the numbering produces (checked ${produced.length})`,
  produced.length >= 10 && producedRejected.length === 0,
  { producedRejected },
);

// USER MODE narrows, and says why.
check("user mode REFUSES a hyphenated name", spawnNameError("my-agent", { userMode: true }) !== undefined);
check(
  "…and the refusal names the actor token, not just 'unsafe'",
  /actor token/.test(spawnNameError("my-agent", { userMode: true }) ?? ""),
  { msg: spawnNameError("my-agent", { userMode: true }) },
);

// UPGRADE SAFETY. Static/open mode keys the actor on the nkey, so the narrow rule must NOT apply
// there — an existing `my-agent` persona has to keep spawning across an upgrade.
check("static/open mode still ACCEPTS a hyphenated name", spawnNameError("my-agent", { userMode: false }) === undefined);

// The traversal guard is unconditional and survives the narrowing.
for (const bad of ["../escape", "a/b", "a\\b", "with space", "dot.name", ""]) {
  check(`path-hostile name ${JSON.stringify(bad)} is refused in BOTH modes`,
    spawnNameError(bad, { userMode: true }) !== undefined && spawnNameError(bad, { userMode: false }) !== undefined);
}

// THE DELEGATION, asserted structurally because it cannot be asserted behaviourally. The narrow
// half must CALL the shipped validator rather than restate its alphabet. A restatement that is
// correct today is behaviourally identical today — that is precisely what makes the drift silent,
// and why every cell above stays green when the call is replaced by an equivalent regex. The only
// moment the two disagree is after someone changes the token grammar, which is exactly the moment
// nobody is looking at this door. So the cell reads the shipped source.
//
// Comments are STRIPPED first: the docstring above `spawnNameError` names `assertValidOwnerToken`
// twice, and a cell that counted its own documentation would pass with the call deleted.
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "agent-file.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
const body = SRC.slice(SRC.indexOf("export function spawnNameError"));
const fnBody = body.slice(0, body.indexOf("\n}") + 2);

check("instrument control: the predicate's source was located, comments stripped",
  fnBody.includes("export function spawnNameError") && fnBody.length > 100 && !fnBody.includes("DELEGATES"),
  { len: fnBody.length });
check("the narrow half CALLS the shipped validator (delegation, not a restatement)",
  fnBody.includes("assertValidOwnerToken("));
check("…and carries no second copy of the token alphabet",
  !/\[A-Za-z0-9_\]\+/.test(fnBody),
  { fnBody: fnBody.slice(0, 400) });

// A good name is accepted in both modes — so the guard above is not just always-refusing.
check("a plain name is accepted in BOTH modes",
  spawnNameError("reviewer", { userMode: true }) === undefined &&
    spawnNameError("reviewer", { userMode: false }) === undefined);

console.log(
  failed === 0
    ? `\n\x1b[32mSPAWN-NAME/ACTOR-TOKEN SMOKE OK ✅\x1b[0m  (${passed} passed, 0 failed)\n`
    : `\n\x1b[31mSPAWN-NAME/ACTOR-TOKEN SMOKE FAILED\x1b[0m  (${passed} passed, ${failed} failed)\n`,
);
process.exit(failed === 0 ? 0 : 1);
