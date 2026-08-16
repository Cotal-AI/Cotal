/** The ACTION COMPOSITE: its declaration in the cluster document, and the two envelope checks it
 *  gates (SPEC §13.7 :1446/:1448).
 *
 *  The composite is a COMMAND MARKER, not a class. An action command's submissions are journal-class,
 *  so `action` implies `class: "journal"` — but the implication runs one way, and the marker is what
 *  makes `goalId` a MUST rather than a shape the parser merely tolerates.
 *
 *  Every assertion here reads the declaration from PARSED bytes, never from a constant: the whole
 *  reason the ceiling lives in the digest-verified surface is that two conforming implementations
 *  must not be able to decide the same submission differently and durably.
 */
import { parseClusterDocument } from "../src/endpoint-cluster.js";
import { assertActionGoalId, assertClassMatches } from "../src/endpoint-envelope.js";
import type { EndpointRequest } from "../src/endpoint-envelope.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const throws = (name: string, fn: () => unknown, needle: string) => {
  try {
    fn();
  } catch (e) {
    const msg = String((e as Error).message);
    ok(name, msg.includes(needle), msg);
    return;
  }
  throw new Error(`FAIL: ${name} — expected a loud throw, got a value`);
};
/** Assert on the wire CODE, not on the prose. The code is the contract a caller branches on; the
 *  message is for a human and may be reworded in any change. A test matching the sentence would
 *  pass for the wrong reason the first time someone improves the wording, and fail for no reason
 *  the second time. */
const throwsCode = (name: string, fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    const actual = (e as { code?: unknown }).code;
    ok(name, actual === code, { expected: code, actual, message: (e as Error).message });
    return;
  }
  throw new Error(`FAIL: ${name} — expected a loud throw, got a value`);
};

const DIGEST = `sha256:${"a".repeat(64)}`;
const command = (over: Record<string, unknown>) => ({
  name: "spawn", class: "journal", targeted: false, capability: "spawn",
  inputDigest: DIGEST, outputDigest: DIGEST, ...over,
});
const doc = (cmd: Record<string, unknown>) => ({
  urn: "ai.cotal.test.cluster", revision: 1, attributes: [], events: [], commands: [cmd],
});
const CEILING = { maxBytes: 65536, maxDepth: 16, maxItems: 256 };

// ---------------------------------------------------------------------------------------------
// 1) The declaration. Presence is CLOSED per command: a parser decides every action field from the
//    current bytes, with no knowledge of who wrote them or which version wrote them.
// ---------------------------------------------------------------------------------------------
const parsed = parseClusterDocument(doc(command({ action: true, admissionCeiling: CEILING })));
ok("action command parses", parsed.commands[0].action === true);
ok("its ceiling survives parsing intact", JSON.stringify(parsed.commands[0].admissionCeiling) === JSON.stringify(CEILING),
  parsed.commands[0].admissionCeiling);

const plain = parseClusterDocument(doc(command({ class: "ephemeral" })));
ok("a non-action command carries no marker", plain.commands[0].action === undefined);
ok("and no ceiling", plain.commands[0].admissionCeiling === undefined);

// `action: false` is refused rather than accepted-as-absent. Two ways to say "not an action" is a
// second source for one fact, and every reader would have to know which one this document used.
throws("action: false is refused, not read as absent",
  () => parseClusterDocument(doc(command({ action: false, class: "ephemeral" }))),
  "is not true");

// The one-way implication, enforced. An action command whose submissions are not journal-class
// would declare a goal rail it cannot ride.
throws("action + ephemeral class is refused",
  () => parseClusterDocument(doc(command({ action: true, class: "ephemeral", admissionCeiling: CEILING }))),
  "an action command's submissions are journal-class");

// A1's MUST. Hardcoding the ceiling in the canonicalizer would satisfy the code and not the
// contract: the caller could not see before submitting what will be refused.
throws("an action command without a ceiling is refused",
  () => parseClusterDocument(doc(command({ action: true }))),
  "must declare admissionCeiling");
for (const [field, bad] of [["maxBytes", 0], ["maxDepth", -1], ["maxItems", 1.5]] as const) {
  throws(`ceiling.${field} = ${bad} is refused`,
    () => parseClusterDocument(doc(command({ action: true, admissionCeiling: { ...CEILING, [field]: bad } }))),
    "is not a positive safe integer");
}

// A ceiling with no submissions to bound, and a readiness bound with no goal to bound, are both
// unreadable by anything — they would sit in the digest-verified surface saying nothing.
throws("a ceiling without the marker is refused",
  () => parseClusterDocument(doc(command({ class: "ephemeral", admissionCeiling: CEILING }))),
  "without the action composite");
throws("readinessDeadlineMs without the marker is refused",
  () => parseClusterDocument(doc(command({ class: "ephemeral", readinessDeadlineMs: 30_000 }))),
  "readiness is goal state");
const ready = parseClusterDocument(doc(command({ action: true, admissionCeiling: CEILING, readinessDeadlineMs: 30_000 })));
ok("readinessDeadlineMs rides an action command", ready.commands[0].readinessDeadlineMs === 30_000);

// ---------------------------------------------------------------------------------------------
// 2) `class-mismatch`. THE J0 RED-FIRST: an `ep.one` (ephemeral) call to a journal-class action is
//    refused at the boundary. Today `spawn` is declared ephemeral, so this refusal is unreachable
//    through the real command — it becomes reachable the moment J2 flips the contract, and the
//    assertion is written against the declaration rather than against the manager so that flipping
//    the contract is the only thing that has to happen for it to be exercised for real.
// ---------------------------------------------------------------------------------------------
const req = (over: Partial<EndpointRequest> = {}): EndpointRequest => ({
  v: 1, id: "01JCOTALREQ0000000000000AA", op: { endpoint: "manager", command: "spawn" },
  class: "ephemeral", from: { id: "owner.actor" }, ...over,
} as EndpointRequest);

throwsCode("ep.one against a journal-class action is refused class-mismatch",
  () => assertClassMatches(req(), parsed.commands[0].class),
  "class-mismatch");
assertClassMatches(req({ class: "journal" }), parsed.commands[0].class);
ok("a journal envelope against the same command is admitted", true);

// ---------------------------------------------------------------------------------------------
// 3) The `goalId` rule, both directions. Neither is a default: the id is CLIENT-generated, so a
//    servicer that minted one would invent the identity the caller correlates its own work by, and
//    a servicer that dropped a stray one would let a caller believe work is tracked that is not.
// ---------------------------------------------------------------------------------------------
throwsCode("an action submission without goalId is refused",
  () => assertActionGoalId(req({ class: "journal" }), true),
  "bad-request");
throwsCode("a goalId on a non-action command is refused",
  () => assertActionGoalId(req({ goalId: "01JCOTALGOAL000000000000AA" }), false),
  "bad-request");
assertActionGoalId(req({ class: "journal", goalId: "01JCOTALGOAL000000000000AA" }), true);
assertActionGoalId(req(), false);
ok("both agreeing shapes are admitted", true);

// ---------------------------------------------------------------------------------------------
// 4) THE MARKER IS NOT THE CLASS, and the four cells above could not tell them apart.
//
//    Every `declaresAction = true` above was paired with `class: "journal"`, and every `false` with
//    an ephemeral envelope. The two inputs were perfectly correlated, so an implementation that
//    IGNORED the marker entirely and gated on `env.class === "journal"` produces the identical
//    pass/throw vector and satisfies all four. A reviewer built that wrong implementation and ran
//    it against these cells; it passed.
//
//    The fix is not a stronger assertion, it is DECORRELATION: a journal-class command that does
//    NOT declare the action composite. Every action command's submissions are journal (SPEC:1446),
//    and that is emphatically not the converse — the composite is a command MARKER, and journal is
//    a class that plenty of non-action commands use. These two cells are the only place in the
//    suite where the two inputs disagree, and they are therefore the only place either is tested.
// ---------------------------------------------------------------------------------------------
throwsCode("a goalId on a JOURNAL-class command that declares NO action is still refused",
  () => assertActionGoalId(req({ class: "journal", goalId: "01JCOTALGOAL000000000000AA" }), false),
  "bad-request");
assertActionGoalId(req({ class: "journal" }), false);
ok("a journal-class NON-action command without goalId is admitted", true);
// And the mirror, so the pair cannot be satisfied by refusing every journal envelope: the marker
// still governs when the class is held constant.
throwsCode("an action command on the same journal class STILL requires goalId",
  () => assertActionGoalId(req({ class: "journal" }), true),
  "bad-request");

console.log(`\nendpoint-action-class smoke: ${pass} checks passed`);
