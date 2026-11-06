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
import ts from "typescript";
import { firstFreeName, spawnNameError } from "../src/agent-file.js";
import { assertBoundedOwner } from "../src/endpoint-subjects.js";
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

// THE LENGTH BOUND (#4981). The bearer exchange refuses an actor through assertBoundedOwner at 64
// characters, and in user mode the name IS that actor. A door that checks only the alphabet accepts
// the name, the host enrolls it, and the refusal lands after the effect. The cells hand the issue's
// own name shape to the door and to the real bound, so the two can disagree only by this reddening.
const servable = (n: string): boolean => {
  try { assertBoundedOwner(n, "actor"); return true; } catch { return false; }
};
const LONG = `cloud_${"a".repeat(64)}`;
const AT64 = "b".repeat(64);
const AT65 = "c".repeat(65);
check("instrument control: the issue's 70-character name is past the exchange bound",
  LONG.length === 70 && !servable(LONG));
check("instrument control: 64 characters is inside the exchange bound and 65 is not",
  AT64.length === 64 && servable(AT64) && AT65.length === 65 && !servable(AT65));
const longRefusal = spawnNameError(LONG, { userMode: true });
check("user mode REFUSES the 70-character name the exchange refuses",
  longRefusal !== undefined && /64 characters/.test(longRefusal), { msg: longRefusal });
check("user mode REFUSES a 65-character name and ACCEPTS a 64-character one",
  spawnNameError(AT65, { userMode: true }) !== undefined && spawnNameError(AT64, { userMode: true }) === undefined);
check("static/open mode still ACCEPTS the 70-character name (the name is not the actor there)",
  spawnNameError(LONG, { userMode: false }) === undefined);
// Numbering widens. A base of 63 characters is itself servable, and its second instance is not.
const AT63 = "d".repeat(63);
const numbered = firstFreeName(AT63, (n) => n === AT63);
check("numbering a 63-character base yields a name past the bound",
  numbered === `${AT63}_2` && numbered.length === 65 && !servable(numbered), { numbered });
check("user mode REFUSES that numbered name", spawnNameError(numbered, { userMode: true }) !== undefined);
let numberingStopped = false;
try { firstFreeName(AT63, (n) => n === AT63, { userMode: true }); }
catch { numberingStopped = true; }
check("user-mode numbering STOPS instead of producing the unservable name", numberingStopped);
check("user-mode numbering still returns a free base unchanged",
  firstFreeName(AT63, () => false, { userMode: true }) === AT63);
const AT62 = "e".repeat(62);
check("user-mode numbering still produces the one instance that fits",
  firstFreeName(AT62, (n) => n === AT62, { userMode: true }) === `${AT62}_2`);
const AT61 = "f".repeat(61);
const takenTo = (last: number) => (n: string) => n === AT61 || Array.from({ length: last - 1 }, (_, i) => `${AT61}_${i + 2}`).includes(n);
check("user-mode numbering of a 61-character base still reaches the 64-character instance",
  firstFreeName(AT61, takenTo(98), { userMode: true }) === `${AT61}_99` && `${AT61}_99`.length === 64);
let hundredthStopped = false;
try { firstFreeName(AT61, takenTo(99), { userMode: true }); }
catch { hundredthStopped = true; }
check("user-mode numbering STOPS at the next instance, which passes the bound", hundredthStopped && `${AT61}_100`.length === 65);
check("numbering without the mode still produces the unservable name (static mode is not the actor)",
  firstFreeName(AT63, (n) => n === AT63) === `${AT63}_2`);

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
// nobody is looking at this door. So the cell parses the shipped source: the docstring above
// `spawnNameError` names `assertValidOwnerToken` twice, and a string can spell the call too.
const DOOR_AST = ts.createSourceFile(
  "agent-file.ts",
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "agent-file.ts"), "utf8"),
  ts.ScriptTarget.Latest,
);
const DOOR = DOOR_AST.statements.find(
  (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "spawnNameError",
);
const TRAVERSAL_GUARD = "/^[A-Za-z0-9_-]+$/";
let validatorCalls = 0;
let boundCalls = 0;
const doorRegexes: string[] = [];
const walkDoor = (node: ts.Node): void => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "assertValidOwnerToken")
    validatorCalls++;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "assertBoundedOwner")
    boundCalls++;
  if (ts.isRegularExpressionLiteral(node)) doorRegexes.push(node.text);
  ts.forEachChild(node, walkDoor);
};
if (DOOR?.body) walkDoor(DOOR.body);

check("instrument control: the predicate was parsed and its regex literals are visible (the traversal guard)",
  DOOR?.body !== undefined && doorRegexes.includes(TRAVERSAL_GUARD),
  { doorRegexes });
check("the narrow half CALLS the shipped validator (delegation, not a restatement)",
  validatorCalls >= 1,
  { validatorCalls });
check("the length half CALLS the shipped actor bound (delegation, not a restated 64)",
  boundCalls >= 1,
  { boundCalls });
check("…and carries no second copy of the token alphabet",
  doorRegexes.every((r) => r === TRAVERSAL_GUARD),
  { doorRegexes });

// A good name is accepted in both modes — so the guard above is not just always-refusing.
check("a plain name is accepted in BOTH modes",
  spawnNameError("reviewer", { userMode: true }) === undefined &&
    spawnNameError("reviewer", { userMode: false }) === undefined);

// THE CLIENT-SIDE PREFLIGHT (#867 residual). The detached CLI used to send `identity: values.name`
// straight to the manager and the operator read the manager's refusal after the round trip. The fix
// is the CLI calling the SAME predicate the manager calls, keyed on the target mesh's auth mode.
// The suite cannot import the CLI's module (core's smoke may not depend on implementations), so
// this pins the behaviour at the shared predicate with the exact argument shapes both call sites
// pass, and the wiring itself is pinned structurally below by reading the CLI's shipped source.
const CLI_REFUSAL_USER = spawnNameError("default_agent-3", { userMode: true });
check("a hyphenated --name on a USER-mode target is refused by the same predicate the manager uses",
  CLI_REFUSAL_USER !== undefined && /actor token/.test(CLI_REFUSAL_USER),
  { msg: CLI_REFUSAL_USER });
check("…the CLI's message is core's own, not a copy (names the separator reservation)",
  typeof CLI_REFUSAL_USER === "string" && CLI_REFUSAL_USER.includes("reserved as the principal name-form separator"),
  { msg: CLI_REFUSAL_USER });
check("the same hyphenated --name on a STATIC-mode target is accepted",
  spawnNameError("default_agent-3", { userMode: false }) === undefined);

// The wiring, asserted structurally for the same reason as the delegation cells above: a call site
// that is absent today is behaviourally indistinguishable from one that delegates faithfully, and
// the only moment the difference shows is after the next grammar change. The source is parsed, so
// the #867 comments, the door's declaration or a string that spells a call cannot pass for one, and
// requoting an argument changes nothing.
const CLI_RAW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "implementations", "cli", "src", "commands", "spawn.ts"),
  "utf8",
);
check("instrument control: the CLI's spawn source was located",
  CLI_RAW.includes("async function launchManagedPersona") && CLI_RAW.includes("export async function spawn"),
  { len: CLI_RAW.length });
const CLI_AST = ts.createSourceFile("spawn.ts", CLI_RAW, ts.ScriptTarget.Latest);
// Parsed, so only a real value import binding the export to its own name counts, wherever it sits in the list.
const CORE_IMPORTS = CLI_AST.statements
  .filter(ts.isImportDeclaration)
  .filter((d) => ts.isStringLiteral(d.moduleSpecifier) && d.moduleSpecifier.text === "@cotal-ai/core" && !d.importClause?.isTypeOnly)
  .flatMap((d) => {
    const named = d.importClause?.namedBindings;
    return named && ts.isNamedImports(named) ? named.elements : [];
  })
  .filter((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === e.name.text)
  .map((e) => e.name.text);
check("the CLI calls the shared name door (import present)",
  CORE_IMPORTS.includes("spawnNameError"));
const DOOR_CALLS: ts.CallExpression[] = [];
const collectDoorCalls = (node: ts.Node): void => {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "refuseUnmintableNameOrExit")
    DOOR_CALLS.push(node);
  ts.forEachChild(node, collectDoorCalls);
};
collectDoorCalls(CLI_AST);
check("the CLI calls the shared name door (call sites: detached + foreground)",
  DOOR_CALLS.length === 2,
  { sites: DOOR_CALLS.length });
// Parentheses change no behaviour, so they must not change the verdict.
const unparen = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;
check("the CLI keys the door on the target mesh's auth mode, not on a restated grammar",
  DOOR_CALLS.length > 0 && DOOR_CALLS.every(({ arguments: [, arg] }) => {
    const mode = arg && unparen(arg);
    if (mode === undefined || !ts.isBinaryExpression(mode) || mode.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
      return false;
    const [left, right] = [unparen(mode.left), unparen(mode.right)];
    return ts.isPropertyAccessExpression(left) && left.name.text === "mode" && ts.isStringLiteralLike(right) && right.text === "user";
  }));

console.log(
  failed === 0
    ? `\n\x1b[32mSPAWN-NAME/ACTOR-TOKEN SMOKE OK ✅\x1b[0m  (${passed} passed, 0 failed)\n`
    : `\n\x1b[31mSPAWN-NAME/ACTOR-TOKEN SMOKE FAILED\x1b[0m  (${passed} passed, ${failed} failed)\n`,
);
process.exit(failed === 0 ? 0 : 1);
