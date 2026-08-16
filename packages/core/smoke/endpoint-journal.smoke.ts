/**
 * v0.4 journal-contract smoke — the §13.4 discipline against a real broker: fingerprint
 * determinism and omission rules, the caller-scoped create-only decision CAS (first decision
 * wins atomically, losers read the winner, distinct callers never squat each other's ids),
 * fact shapes with their validators, size preflight, and plain (dedupe-header-free) appends.
 *
 * Run: pnpm smoke:ep-journal   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, EpEnvelopeError,
  submissionFingerprint, decideAdmission, epfDecisionSubject, epfQuarantineSubject, epfGoalBindSubject,
  epfEffectSubject, parseEffectFact,
  epjStreamName, epfStreamName, canonDurable,
  parseDecisionFact, parseQuarantineFact, assertFactFits,
  appendSubmission, publishFactCreateOnly, readLastFact,
  epjSubject, epRequestSubject, parseEpSubject,
  type AcceptanceFact, type RejectionFact, type QuarantineFact, type ParsedEpRequest, type EpCaller,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
// A PASSING CELL PRINTS. It used to be silent, and silence is not free: `mutation-proof` counts
// `✓` marks to tell "the mutation applied and nothing caught it" apart from "the run died before
// reaching the cell", and a suite that prints nothing on success reports zero marks — so that
// protection was inert here while the runner reported a number as though it applied. Every mutant
// aimed at this file was graded on its named red alone. The named red is direct evidence and those
// kills stand; the floor that backs it up simply was not there, and nothing said so.
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown) => { try { fn(); c(n, false, "no throw"); } catch { c(n, true); } };
/** Assert a throw AND that it is about the right thing. A bare `throws` passes on a refusal for the
 *  WRONG reason, which matters wherever two guards can refuse the same fixture — the cells below
 *  cross a discriminant check and a closed-key check, and a bare throw cannot tell which fired. */
const refusesWith = (n: string, fn: () => unknown, matching: RegExp) => {
  try { fn(); c(n, false, "did NOT throw"); }
  catch (e) { const m = (e as Error).message; c(n, matching.test(m), { expected: String(matching), got: m }); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const caller2: EpCaller = { owner: "u_zed", actor: "worker", uid: "z".repeat(26) };
const NONCE = "n".repeat(24);
const D = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;

// ── fingerprint (broker-free) ──
const subj = parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "spawn", caller, nonce: NONCE })) as ParsedEpRequest;
const sub1 = { v: 1, id: "req-1", op: { endpoint: "manager", command: "spawn", inputDigest: D, outputDigest: D }, class: "journal", replyExpected: false, deadlineMs: 5000, args: { name: "x" }, from: { id: "u_abc.worker", name: "w" } };
const f1 = submissionFingerprint(sub1, subj);
c("fingerprint is deterministic", f1.fingerprint === submissionFingerprint({ ...sub1 }, subj).fingerprint);
c("the caller identity rides the SUBJECT, not the body",
  (f1.object.caller as { id: string }).id === "u_abc.worker" && (f1.object.caller as { lifecycleUid: string }).lifecycleUid === UID);
c("absent args are OMITTED, never null (changes the digest)",
  submissionFingerprint({ ...sub1, args: undefined }, subj).fingerprint !== f1.fingerprint
  && !("args" in submissionFingerprint({ ...sub1, args: undefined }, subj).object));
c("an incomplete envelope fingerprints the subset it carries",
  typeof submissionFingerprint({ id: "req-1" }, subj).fingerprint === "string"
  && !("class" in submissionFingerprint({ id: "req-1" }, subj).object));
c("authDigest joins the fingerprint iff auth is present",
  "authDigest" in submissionFingerprint({ ...sub1, auth: "{}" }, subj).object && !("authDigest" in f1.object));
const targeted = parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "stop", target: { mode: "owner", tOwner: "u_abc" }, caller, nonce: NONCE })) as ParsedEpRequest;
c("the authz mode rides the subject into the fingerprint",
  submissionFingerprint(sub1, targeted).object.authz === "owner");
throws("a lone-surrogate auth slot has NO fingerprint (quarantine path)",
  () => submissionFingerprint({ ...sub1, auth: "\ud800" }, subj));
c("wrong-typed carried auth is fingerprinted AS CARRIED, never collapsed onto absent",
  submissionFingerprint({ ...sub1, auth: null }, subj).fingerprint !== f1.fingerprint
  && submissionFingerprint({ ...sub1, auth: 123 }, subj).fingerprint !== f1.fingerprint
  && submissionFingerprint({ ...sub1, auth: null }, subj).fingerprint !== submissionFingerprint({ ...sub1, auth: 123 }, subj).fingerprint);

// ── admission: the CLOSED outcome table against a DECLARED ceiling (broker-free) ──
// Every ceiling here is a parameter read from a declaration, never a constant. That is the whole
// point of amendment A1: two conforming implementations must not be able to decide the same bytes
// differently and durably, and a constant compiled into one of them can.
const CEIL = { maxBytes: 4096, maxDepth: 8, maxItems: 64 };
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const admit = (body: unknown, over: Partial<typeof CEIL> = {}, raw?: Uint8Array) =>
  decideAdmission(raw ?? bytes(body), body, subj, { ...CEIL, ...over });

// c1 — the RAW-byte ceiling, decided BEFORE parsing. Parsing is the work the ceiling exists to
// refuse, so a ceiling evaluated after it has already paid the cost it was meant to avoid.
const overRaw = admit(sub1, {}, new Uint8Array(CEIL.maxBytes + 1));
c("c1 raw bytes over maxBytes quarantine", overRaw.outcome === "quarantine", overRaw);
c("c1 names the size cause", overRaw.outcome === "quarantine" && overRaw.cause === "submission-too-large", overRaw);

// c2/c3 — depth and member counts, on the PARSED value.
let deep: unknown = 1;
for (let i = 0; i < 12; i++) deep = { n: deep };
const overDeep = admit({ ...sub1, args: deep });
c("c2 depth over maxDepth quarantines", overDeep.outcome === "quarantine", overDeep);
c("c2 names the depth cause", overDeep.outcome === "quarantine" && overDeep.cause === "submission-too-deep", overDeep);
const overItems = admit({ ...sub1, args: { list: Array.from({ length: 200 }, (_, i) => i) } });
c("c3 item count over maxItems quarantines", overItems.outcome === "quarantine", overItems);
c("c3 names the item cause", overItems.outcome === "quarantine" && overItems.cause === "submission-too-many-items", overItems);

// c4 — DETERMINISM, which is what makes wall time non-semantic. The same submission decides the
// same way on every delivery, and a submission inside every ceiling is NEVER quarantined however
// long a worker takes: nothing in the decision reads a clock, so there is no elapsed time for a
// redelivery to disagree about.
const first = admit(sub1), second = admit(sub1);
c("c4 the same submission decides identically on redelivery",
  JSON.stringify(first) === JSON.stringify(second), { first, second });
c("c4 a within-ceiling submission is ADMITTED, never quarantined", first.outcome === "admit", first);
// AND THE TWO ASSERTIONS ABOVE CANNOT SEE A CLOCK, which mutation-proof demonstrated rather than
// argued: injecting `if (Date.now() % 2 === 0) return quarantine` SURVIVED both of them. Two calls
// microseconds apart agree with each other whatever the clock says, and the admit assertion is a
// coin flip that lands right half the time — a cell that reddens on half its runs is worse than no
// cell, because the half that passes reads as proof.
//
// So determinism is asserted where it is actually decidable: the decision path must contain no
// clock read at all. A source-level assertion is a weaker KIND of claim than a behavioural one,
// and it is the strongest claim that is true here — the function takes no clock, so there is no
// clock to inject and nothing behavioural to observe. Injecting one reddens this every time.
// THE SPAN IS THE WHOLE CALLEE SET, AND IT HAS BEEN TOO NARROW TWICE. It first began at
// `decideAdmission`, missing `measure()`. Widened to `measure(`, it STILL missed
// `submissionFingerprint` — which `decideAdmission` also calls, which sits above `measure`, and
// into which a day-bucket clock could be added while every behavioural cell agreed all day and the
// regex passed because the clock was before `spanFrom`. A reviewer found that; I had already
// "fixed" this once and recorded the fix as complete.
// The lesson is not "pick a wider marker". It is that a source-span claim is only as wide as the
// text it reads, and the author is the worst judge of where the text ends, because the author is
// choosing the marker from the same mental model that produced the gap.
// `canonical.ts` is the one dependency outside this file; checked once, by hand, and it reads no
// clock — recorded here because a hand check that is not written down has to be redone by the reader.
const decisionSource = readFileSync(new URL("../src/endpoint-journal.ts", import.meta.url), "utf8");
const spanFrom = decisionSource.indexOf("export function submissionFingerprint");
const spanTo = decisionSource.indexOf("\n// ---- fact shapes");
// A marker that moved would make `slice` silently return the wrong region — and an empty region
// passes the regex trivially. The cell must fail loudly rather than pass vacuously.
if (spanFrom < 0 || spanTo < 0 || spanTo <= spanFrom)
  throw new Error(`c4 cannot locate the decision path in endpoint-journal.ts (from=${spanFrom} to=${spanTo}) — the markers moved; fix the span, do not delete the cell`);
const decidePath = decisionSource.slice(spanFrom, spanTo);
c("c4 the decision path reads no clock (the property, asserted where it is decidable)",
  !/Date\.now|new Date|performance\.now|hrtime/.test(decidePath), `${decidePath.length} bytes spanned`);
c("c4 admission carries the fingerprint the caller can correlate on",
  first.outcome === "admit" && first.fingerprint === submissionFingerprint(sub1, subj).fingerprint);

// c5 — no usable `id`, and it is a DISTINCT cause from the ceilings. Both quarantine; they are
// different facts about the submission, and an operator who cannot tell them apart cannot tell a
// misconfigured caller from a corrupt one.
const noId = admit({ ...sub1, id: undefined });
c("c5 a submission with no usable id quarantines", noId.outcome === "quarantine", noId);
c("c5 the cause is DISTINCT from every ceiling cause",
  noId.outcome === "quarantine" && noId.cause === "no-usable-id", noId);
// c5b — NON-EMPTY IS NOT USABLE, and the previous cells only ever tested ABSENT and EMPTY. The id
// becomes a subject token, so an id outside the token grammar addresses no subject at all, exactly
// as a missing one does not. Before this, `bad.id` was ADMITTED here and threw at the subject
// builder later — a submission defect converted into an internal error at a boundary that had
// already said yes. Found by a reviewer, not by the six ceiling mutants that pass either way.
for (const badId of ["bad.id", "has space", "x".repeat(200), "UPPER!", "tab\there"]) {
  const r = admit({ ...sub1, id: badId });
  c(`c5b a malformed non-empty id (${JSON.stringify(badId)}) quarantines no-usable-id`,
    r.outcome === "quarantine" && r.cause === "no-usable-id", r);
}
c("c5b and a WELL-FORMED id still admits — the check refuses a grammar, not every id",
  admit({ ...sub1, id: "req-1" }).outcome === "admit");

// c7 — PRECEDENCE. Each cell above tests ONE breach in isolation, and isolated cells cannot pin an
// ORDER: move the unparseable check ahead of the raw-byte ceiling and every one of them stays
// green. The order is load-bearing — the raw ceiling exists to refuse work BEFORE paying for it —
// so the overlaps are asserted directly. Each row below breaches two rules at once and names which
// one must win.
const tooBigUnparseable = decideAdmission(new Uint8Array(CEIL.maxBytes + 1), undefined, subj, CEIL);
c("c7 raw-bytes BEFORE unparseable: oversized junk is too-large, not no-usable-id",
  tooBigUnparseable.outcome === "quarantine" && tooBigUnparseable.cause === "submission-too-large", tooBigUnparseable);
let deepWide: unknown = Array.from({ length: 200 }, (_, i) => i);
for (let i = 0; i < 12; i++) deepWide = { n: deepWide };
const depthAndItems = admit({ ...sub1, args: deepWide });
c("c7 depth BEFORE items when both breach",
  depthAndItems.outcome === "quarantine" && depthAndItems.cause === "submission-too-deep", depthAndItems);
const itemsAndNoId = admit({ ...sub1, id: undefined, args: { list: Array.from({ length: 200 }, (_, i) => i) } });
c("c7 items BEFORE no-usable-id when both breach",
  itemsAndNoId.outcome === "quarantine" && itemsAndNoId.cause === "submission-too-many-items", itemsAndNoId);
const noIdAndSurrogate = admit({ ...sub1, id: undefined, args: { s: "\uD800" } });
c("c7 no-usable-id BEFORE no-canonical-form when both breach",
  noIdAndSurrogate.outcome === "quarantine" && noIdAndSurrogate.cause === "no-usable-id", noIdAndSurrogate);

// c8 — DUPLICATE NAMES, which no post-parse check can see. `JSON.parse('{"id":"a","id":"b"}')`
// yields `{id:"b"}` and reports nothing, so a submission two conforming implementations could read
// DIFFERENTLY arrived here looking ordinary. The module claimed this cause from the day it was
// written and the case was UNREACHABLE — not untested, unrepresentable. A reviewer found it; no
// mutant aimed at this file could have, because a mutation of an unreachable branch survives.
const dupRaw = new TextEncoder().encode('{"id":"req-1","id":"req-2","op":{"endpoint":"manager","command":"spawn"}}');
const dupDecided = decideAdmission(dupRaw, JSON.parse(new TextDecoder().decode(dupRaw)), subj, CEIL);
c("c8 duplicate object names quarantine as no-canonical-form",
  dupDecided.outcome === "quarantine" && dupDecided.cause === "no-canonical-form", dupDecided);
// The raw bytes carry THREE names and the parsed value has TWO. That difference IS the finding,
// so the cell states both sides rather than a bare count I could get wrong — and did: I first
// wrote 3, which is the number in the bytes, not the number that survives the parse.
c("c8 and the parsed value alone CANNOT show it — the duplicate is gone before the decision sees it",
  Object.keys(JSON.parse(new TextDecoder().decode(dupRaw))).length === 2
  && (JSON.parse(new TextDecoder().decode(dupRaw)) as { id: string }).id === "req-2");
// Nested, so the scanner is not merely checking the top level.
const dupNested = new TextEncoder().encode('{"id":"req-1","args":{"a":1,"a":2}}');
c("c8 a duplicate NESTED name is caught too",
  decideAdmission(dupNested, JSON.parse(new TextDecoder().decode(dupNested)), subj, CEIL).cause === "no-canonical-form");
// THE NEGATIVE SIDE, which is what stops the scanner degenerating into "refuse everything".
// Each fixture below is BUILT and then serialised, never hand-escaped — my first attempt at writing
// those escapes by hand produced invalid JSON.
//
// A NEGATIVE CELL IS ONLY WORTH ITS MUTANT. My first two negatives both asserted `admit` on one
// fixture of sibling objects and quoted braces, and BOTH survived the mutants aimed at them:
// running the mutated scanner directly showed the sibling case takes the same path with the frame
// pop removed, and the quoted-brace case takes the same path with escape handling removed. The
// mutants were sound — they broke the scanner on OTHER inputs — so the fixture was the weak part,
// and the cell that named siblings was describing a mechanism the pop does not implement. Sibling
// frames are safe either way, because names are recorded on the top frame and each `{` pushes a
// fresh one. What the pop actually protects is the shape below: an inner object CLOSES, and its
// names must not still be in scope for the outer one.
const admits = (label: string, body: unknown) => {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const d = decideAdmission(raw, JSON.parse(new TextDecoder().decode(raw)), subj, CEIL);
  c(label, d.outcome === "admit", d);
};
admits("c8 a name reappearing at the OUTER level after an inner object closes is legal",
  { id: "req-1", args: { k: 1 }, k: 2 });
admits("c8 and the same after an ARRAY of objects closes", { id: "req-1", c: [{ k: 1 }], k: 2 });
// A string whose CONTENTS spell a name and a separator. If escapes stop being honoured the string
// terminates at its first `\"` and the rest of it is read as structure, which invents a second
// top-level `id` that was never there.
admits("c8 a string spelling out a name is CONTENT, never structure", { id: "r", a: '":"x", "id', b: 2 });
admits("c8 quoted braces and a trailing backslash are content too",
  { id: "req-1", args: { a: '{"a":1}', b: "x\\", c: [{ k: 1 }, { k: 2 }], d: { k: 3 } } });

const unparseable = decideAdmission(new Uint8Array([0xff, 0xfe]), undefined, subj, CEIL);
c("c5 unparseable bytes take the same distinct cause",
  unparseable.outcome === "quarantine" && unparseable.cause === "no-usable-id", unparseable);
c("c5 a lone surrogate has no canonical form and says so",
  admit({ ...sub1, args: { s: "\uD800" } }).outcome === "quarantine");
const surrogate = admit({ ...sub1, args: { s: "\uD800" } });
c("c5 and that cause is no-canonical-form, not no-usable-id",
  surrogate.outcome === "quarantine" && surrogate.cause === "no-canonical-form", surrogate);

// c6 — the ONLY ceiling-adjacent outcome that produces a caller-addressed decision fact. It is a
// rejection rather than a quarantine for exactly one reason: the fingerprint exists by then, so
// there is a caller-scoped subject to write the answer to (SPEC:1610-1612).
// AND IT IS REACHABLE WITHOUT CONTRIVANCE, which is why the two paths differ at all: the
// fingerprint replaces `auth` with a DIGEST, so a one-character secret becomes 71 characters and
// the canonical form is larger than the bytes that arrived. Measured here: 91 raw, 229 canonical.
const authed = { v: 1, id: "req-c6", op: { endpoint: "manager", command: "spawn" }, class: "journal", auth: "s" };
c("c6 the canonical form can EXCEED the raw bytes (auth becomes a digest)",
  bytes(authed).byteLength < new TextEncoder().encode(JSON.stringify(submissionFingerprint(authed, subj).object)).byteLength);
const post = admit(authed, { maxBytes: 150 });
c("c6 a post-canonical breach REJECTS, never quarantines", post.outcome === "reject", post);
c("c6 the rejection is resource-exhausted", post.outcome === "reject" && post.code === "resource-exhausted", post);
c("c6 and it carries the fingerprint that makes the caller addressable",
  post.outcome === "reject" && post.fingerprint.startsWith("sha256:"), post);

// ── fact shapes + consuming-boundary validation (broker-free) ──
// Every consuming boundary proves body↔subject agreement, so the parsers take the authenticated
// fact subject. These are the same subjects the CAS below publishes on.
const accSubj = epfDecisionSubject("demo", subj, "req-1"); // …epf.manager.dec.u_abc.worker.<UID>.req-1
const quarSubj = epfQuarantineSubject("demo", "manager", 9);
const acc: AcceptanceFact = {
  v: 1, id: "req-1", decision: "accepted", fingerprint: f1.fingerprint,
  request: sub1 as unknown as Record<string, unknown>,
  caller: { id: "u_abc.worker", lifecycleUid: UID },
  contractDigests: { input: D, output: D }, authzDecision: { revision: 3, epoch: 1 },
  route: "effects", sourceSeq: 7, ts: 1_720_600_000_000,
};
c("an acceptance fact validates", (parseDecisionFact(acc, accSubj) as AcceptanceFact).route === "effects");
const pooled: AcceptanceFact = { ...acc, route: "pool.builds", workExpiry: 1_720_600_100_000 };
c("a pool-routed acceptance carries its workExpiry", (parseDecisionFact(pooled, accSubj) as AcceptanceFact).workExpiry === 1_720_600_100_000);
throws("a pool route WITHOUT workExpiry refuses", () => parseDecisionFact({ ...acc, route: "pool.builds" }, accSubj));
throws("an effects route WITH workExpiry refuses", () => parseDecisionFact({ ...acc, workExpiry: 5 }, accSubj));
// c9 — THE EFFECT COMPLETION UNION'S `outcome` DISCRIMINANT, which nothing in this tree read.
// Found by a static sweep of every refusal code the source can emit against every suite in the
// repo: `"ran"` was the one literal with ZERO occurrences in 301 suite files. It is not Lane A
// behaviour and predates this branch — but it sits in the file J1 hardens, and the refusal below
// was unasserted, so a mutation could delete it and no suite anywhere would notice.
//
// THE SHARPER HALF IS WHAT THE SOURCE CLAIMS ABOUT ITS READERS. The union's doc comment says every
// member declares its outcome "so ... every reader is forced to read the outcome". The two readers
// that exist test `"cancelled" in fact` — the STRUCTURAL check the discriminant was added to make
// unnecessary. The claim is about callers, and no caller honours it. Asserted here at the parser,
// where it is decidable, rather than left as a sentence about code elsewhere.
const effSubj = epfEffectSubject("demo", "manager", caller, "eff-1");
const effRan = { v: 1, id: "eff-1", fingerprint: f1.fingerprint, caller: { id: "u_abc.worker", lifecycleUid: UID }, sourceSeq: 7, ts: 1_720_600_000_000, outcome: "ran" };
c("c9 a `ran` effect fact parses AND carries the discriminant", parseEffectFact(effRan, effSubj).outcome === "ran");
refusesWith("c9 an effect fact with NO outcome refuses, naming the discriminant",
  () => parseEffectFact({ ...effRan, outcome: undefined }, effSubj), /outcome must be/);
refusesWith("c9 an effect fact claiming a foreign outcome refuses, naming the discriminant",
  () => parseEffectFact({ ...effRan, outcome: "ok" }, effSubj), /outcome must be/);
// The comment promises a member cannot claim one outcome while carrying the other's fields. That is
// the closed-key check, and it is a DIFFERENT rule from the discriminant — so it gets its own cell
// in each direction rather than riding on the one above.
refusesWith("c9 `ran` carrying the cancelled block refuses on CLOSED KEYS, not on the discriminant",
  () => parseEffectFact({ ...effRan, cancelled: { opId: "op-1", target: { owner: "u_abc", actor: "worker", lifecycleUid: UID } } }, effSubj), /unknown field|closed|cancelled/);
refusesWith("c9 and `cancelled` WITHOUT its block refuses",
  () => parseEffectFact({ ...effRan, outcome: "cancelled" }, effSubj), /cancelled/);

const rej: RejectionFact = {
  v: 1, id: "req-1", decision: "rejected", fingerprint: f1.fingerprint,
  error: { code: "conflict", detail: "same id, different fingerprint" },
  caller: { id: "u_abc.worker", lifecycleUid: UID }, sourceSeq: 8, ts: 1_720_600_000_001,
};
c("a rejection fact validates (as durable as acceptance)", parseDecisionFact(rej, accSubj).decision === "rejected");
throws("an over-256-byte error detail refuses", () => parseDecisionFact({ ...rej, error: { code: "conflict", detail: "x".repeat(257) } }, accSubj));
throws("an off-catalog error code refuses", () => parseDecisionFact({ ...rej, error: { code: "Oops" } }, accSubj));

// A stored fact must be SELF-SUFFICIENT canonical authority and AGREE with its subject —
// malformed-authority repros the panel found must all fail loud at the consuming boundary.
throws("a rejection with an empty caller principal refuses",
  () => parseDecisionFact({ ...rej, caller: { id: "", lifecycleUid: "" } }, accSubj));
throws("a decision with sourceSeq 0 refuses (a fact rides a positive stream sequence)",
  () => parseDecisionFact({ ...rej, sourceSeq: 0 }, accSubj));
throws("a rejection with a wrong-typed authzDecision refuses",
  () => parseDecisionFact({ ...rej, authzDecision: "not-an-object" }, accSubj));
throws("an acceptance whose request is not the canonical EndpointRequest refuses",
  () => parseDecisionFact({ ...acc, request: {} }, accSubj));
throws("an acceptance whose embedded request.id disagrees with the fact refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, id: "req-2" } }, accSubj));
throws("an acceptance whose embedded request names a different endpoint refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, op: { ...sub1.op, endpoint: "other" } } }, accSubj));
// The embedded request must be a FULLY canonical EndpointRequest (routed through the request
// boundary), not a {v,id,class,op} shell — the panel's partial-fix repros.
throws("an embedded request missing its mandatory journal deadlineMs refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, deadlineMs: undefined } }, accSubj));
throws("an embedded request missing its non-describe contract digests refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, op: { endpoint: "manager", command: "spawn" } } }, accSubj));
throws("an embedded request with replyExpected:true (not a journal cast) refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, replyExpected: true } }, accSubj));
throws("an embedded request whose from.id contradicts the authenticated fact caller refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, from: { id: "u_evil.other", name: "w" } } }, accSubj));
// The acceptance must expose ONE coherent effect authority (the panel's cross-field binding
// repros): target presence equivalent to the request's, the FULL tuple + any pinned
// mappingRevision equal, and the fact's contractDigests equal to the pinned op digests.
const tTup = { owner: "u_zed", actor: "svc", lifecycleUid: "z".repeat(26) };
const tReq = { ...sub1, target: tTup };
throws("an acceptance with a non-object target refuses",
  () => parseDecisionFact({ ...acc, request: tReq, target: 42 }, accSubj));
throws("a fact target naming a different alias than the request's target refuses",
  () => parseDecisionFact({ ...acc, request: tReq, target: { ...tTup, owner: "u_other" } }, accSubj));
throws("a fact target naming a different lifecycleUid than the request's expected UID refuses",
  () => parseDecisionFact({ ...acc, request: tReq, target: { ...tTup, lifecycleUid: "y".repeat(26) } }, accSubj));
throws("a fact target altering the mappingRevision the request pinned refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, target: { ...tTup, mappingRevision: 4 } }, target: { ...tTup, mappingRevision: 9 } }, accSubj));
throws("a fact target dropping the mappingRevision the request pinned refuses",
  () => parseDecisionFact({ ...acc, request: { ...sub1, target: { ...tTup, mappingRevision: 4 } }, target: tTup }, accSubj));
throws("a targeted request whose acceptance dropped the target refuses (not self-sufficient)",
  () => parseDecisionFact({ ...acc, request: tReq }, accSubj));
throws("an untargeted request with a spurious fact target refuses (smuggled authority)",
  () => parseDecisionFact({ ...acc, target: tTup }, accSubj));
throws("fact contractDigests.input disagreeing with the pinned op.inputDigest refuses",
  () => parseDecisionFact({ ...acc, contractDigests: { input: D2, output: D } }, accSubj));
throws("fact contractDigests.output disagreeing with the pinned op.outputDigest refuses",
  () => parseDecisionFact({ ...acc, contractDigests: { input: D, output: D2 } }, accSubj));
c("ts:0 and readinessDeadlineMs:0 are CONFORMING (non-negative wire integers, not positive)",
  parseDecisionFact({ ...rej, ts: 0 }, accSubj).decision === "rejected"
  && (parseDecisionFact({ ...acc, readinessDeadlineMs: 0 }, accSubj) as AcceptanceFact).readinessDeadlineMs === 0);
c("a coherent resolved target validates (an omitted request mappingRevision is the ONE fill)",
  (parseDecisionFact({ ...acc, request: tReq, target: { ...tTup, mappingRevision: 4 } }, accSubj) as AcceptanceFact).decision === "accepted"
  && (parseDecisionFact({ ...acc, request: { ...sub1, target: { ...tTup, mappingRevision: 4 } }, target: { ...tTup, mappingRevision: 4 } }, accSubj) as AcceptanceFact).decision === "accepted");
throws("a fact whose body id disagrees with the subject refuses (no cross-id smuggling)",
  () => parseDecisionFact({ ...rej, id: "req-9" }, accSubj));
throws("a fact whose body caller disagrees with the subject refuses",
  () => parseDecisionFact({ ...rej, caller: { id: "u_zed.worker", lifecycleUid: caller2.uid } }, accSubj));
throws("parseDecisionFact on a non-decision subject refuses",
  () => parseDecisionFact(rej, quarSubj));

const quar: QuarantineFact = {
  v: 1, decision: "quarantined", sourceSeq: 9,
  submissionDigest: D, error: { code: "bad-request", detail: "not canonicalizable I-JSON" }, ts: 1_720_600_000_002,
};
c("a quarantine fact validates (no id, no fingerprint required)", parseQuarantineFact(quar, quarSubj).sourceSeq === 9);
throws("a quarantine fact whose sourceSeq disagrees with its subject refuses",
  () => parseQuarantineFact({ ...quar, sourceSeq: 10 }, quarSubj));
c("size preflight passes a bounded fact", assertFactFits(rej, 1024 * 1024).length > 0);
throws("size preflight refuses an acceptance that cannot fit", () => assertFactFits(acc, 64));

// ── the decision CAS + plain appends (real broker) ──
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-epjrn-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  // The smoke is its own composition root: the two §13.12 streams (full config lands with the
  // 13.12 binding slice; here: capture subjects + allow_direct for the fact reads).
  await jsm.streams.add({ name: epjStreamName("epjrn"), subjects: ["cotal.epjrn.epj.>"] });
  await jsm.streams.add({ name: epfStreamName("epjrn"), subjects: ["cotal.epjrn.epf.>"], allow_direct: true });
  c("stream names are the 13.12 forms", epjStreamName("epjrn") === "EPJ_epjrn" && canonDurable("manager") === "canon_manager");

  // Plain append: no dedupe header of any kind on the stored copy.
  const jSubj = epjSubject("epjrn", { endpoint: "manager", command: "spawn", caller });
  const { seq } = await appendSubmission(js, jSubj, sub1);
  c("a submission appends plain", seq === 1);
  // Harness inspection via the classic MSG.GET (EPJ deliberately has no allow_direct, §13.12).
  const stored = await jsm.streams.getMessage(epjStreamName("epjrn"), { last_by_subj: jSubj });
  c("the stored copy carries NO Nats-Msg-Id (native dedupe never relied upon)",
    stored !== null && !stored.header?.get("Nats-Msg-Id"));

  // First decision wins atomically; the loser reads the winner instead of deciding again.
  const dSubj = epfDecisionSubject("epjrn", subj, "req-1");
  const w1 = await publishFactCreateOnly(js, dSubj, assertFactFits(acc, 1024 * 1024));
  c("the first decision wins its CAS", w1.won);
  const w2 = await publishFactCreateOnly(js, dSubj, assertFactFits(rej, 1024 * 1024));
  c("a second decision on the same subject LOSES", !w2.won);
  const winner = parseDecisionFact(await readLastFact(jsm, epfStreamName("epjrn"), dSubj), dSubj);
  c("the loser reads the winning fact (accepted, not the late rejection)", winner.decision === "accepted");

  // Distinct callers can never squat each other's ids: the caller triple is in the subject.
  const subj2 = parseEpSubject(epRequestSubject("demo", { route: { mode: "one" }, endpoint: "manager", command: "spawn", caller: caller2, nonce: NONCE })) as ParsedEpRequest;
  const w3 = await publishFactCreateOnly(js, epfDecisionSubject("epjrn", subj2, "req-1"),
    assertFactFits({ ...rej, caller: { id: "u_zed.worker", lifecycleUid: caller2.uid } }, 1024 * 1024));
  c("the same id under another caller is a DIFFERENT subject and wins", w3.won);

  // THE LOSER'S READ IS BY SUBJECT, AND ONLY NOW IS THAT DECIDABLE. The assertion above cannot
  // fail: create-only leaves EXACTLY ONE fact on `dSubj`, so any read that returns anything at all
  // returns the winner, and a read with no last-by-subject semantics would have passed it. The
  // stream's newest message is now w3's REJECTION on another caller's subject — a different
  // decision, on a different subject, with the same request id. Re-reading `dSubj` here is the
  // first point at which "reads the winner" and "reads the latest thing in the stream" give
  // different answers, so it is the first point at which the claim is worth making.
  // Read RAW and assert before parsing. `parseDecisionFact` validates the fact against the subject
  // it was asked for and throws on a mismatch — correct, but a throw makes the SCENARIO red rather
  // than this cell, and a red that is not the named assertion is not evidence for this claim.
  const reread = await readLastFact(jsm, epfStreamName("epjrn"), dSubj) as { decision?: unknown } | undefined;
  c("the loser's read is scoped to its SUBJECT, not to the stream's newest fact",
    reread?.decision === "accepted", { reread, streamNewestIs: "w3 rejection on subj2" });
  const stillWinner = parseDecisionFact(reread, dSubj);
  c("and it still parses against the subject it was read for", stillWinner.decision === "accepted");

  // Quarantine + goal-bind families: disjoint namespaces, same create-only discipline.
  const qSubj = epfQuarantineSubject("epjrn", "manager", seq);
  c("quarantine keys on the source sequence", qSubj.endsWith(`.quar.${seq}`));
  const wq = await publishFactCreateOnly(js, qSubj, assertFactFits(quar, 1024 * 1024));
  c("a quarantine fact publishes create-only", wq.won);
  c("the goal-bind subject is the caller-scoped .bind leaf",
    epfGoalBindSubject("epjrn", subj, "g1") === `cotal.epjrn.epf.manager.goal.u_abc.worker.${UID}.g1.bind`);
  c("fact subjects derive STRUCTURALLY from the authenticated request (no body argument exists)",
    dSubj === `cotal.epjrn.epf.manager.dec.u_abc.worker.${UID}.req-1`);
  const wg = await publishFactCreateOnly(js, epfGoalBindSubject("epjrn", subj, "g1"),
    new TextEncoder().encode(JSON.stringify({ v: 1, fingerprint: f1.fingerprint })));
  const wg2 = await publishFactCreateOnly(js, epfGoalBindSubject("epjrn", subj, "g1"),
    new TextEncoder().encode(JSON.stringify({ v: 1, fingerprint: "sha256:" + "b".repeat(64) })));
  c("the goal bind is first-wins (a second id naming one goal stops BEFORE acceptance)", wg.won && !wg2.won);

  await nc.drain().catch(() => {});
  console.log(`\nENDPOINT JOURNAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  if (broker.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(200);
  rmSync(sd, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
