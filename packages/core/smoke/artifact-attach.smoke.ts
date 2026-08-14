/**
 * The `confirmAttach` refusal suite — every predicate named, and a CONTROL that succeeds.
 *
 * THE VERB NOW HAS ONE REFUSAL NAME, WHICH CHANGES WHAT THIS SUITE CAN AND CANNOT ASSERT.
 * `channelMismatch`, `noArtifactPart` and `digestMismatch` were removed: they were licensed by an
 * entitlement the sender compare does not establish, and a same-alias successor could read a
 * predecessor's entry off them (see S1). So a cell can no longer prove WHICH predicate fired, and
 * one written as if it could would be agreeing with itself.
 *
 * What replaces the discriminator, in three layers:
 *   - each predicate keeps a cell asserting its fixture is REFUSED AT ALL. Deleting the check makes
 *     that fixture SUCCEED, and no collapse can hide a success.
 *   - matched pairs where a mutation must flip BOTH arms — A3-payload/A3-subject for the subject-vs
 *     -payload channel compare, A5-multi/A5-multi3 for the digest match.
 *   - indistinguishability asserted as a SET OF SIZE ONE across probe shapes (S1, and the foreign
 *     block), which is the only form that can fail on a leak through a shape nobody enumerated.
 *
 * Every failure here otherwise has the same observable — no attachment row — and a single bit
 * cannot be a suite.
 *
 * WHY THE CONTROL CELL IS NOT OPTIONAL. A suite where everything is rejected is unfalsifiable: it
 * passes identically against a verb that refuses correctly and against one that refuses everything,
 * including valid input. The control is what turns the refusals into evidence.
 *
 * Run: pnpm smoke:artifact-attach
 */
import {
  ATTACH_REFUSAL, ATTACH_REFUSALS, confirmAttach,
  type ConfirmAttachArgs, type ConfirmAttachReply, type ConfirmAttachDeps,
} from "../src/artifact-attach.js";
import { chatSubject } from "../src/subjects.js";
import { AmbiguousAclAlias } from "../src/acls.js";
import { ARTIFACT_PART_KIND } from "../src/artifact.js";
import type { CotalMessage } from "../src/types.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

/**
 * THE HELPER. It takes the expected refusal BY NAME and cannot pass on a different one.
 *
 * Four ways to fail, kept distinct because they are four different bugs:
 *   1. the call SUCCEEDED           — the verb accepted input it must refuse
 *   2. it threw instead of replying — a refusal is a reply on this rail, not an exception
 *   3. it refused with another name — the predicate under test is not the one that fired
 *   4. it refused with an UNKNOWN name — a refusal outside the closed vocabulary, which is how a
 *      typo'd string silently becomes a new API nobody declared
 *
 * (3) is the one that matters most: a suite matching refusals by substring, or by a literal retyped
 * in the test, is not checking a mapping — it is agreeing with itself.
 */
const refuses = async (
  what: string,
  expected: string,
  fn: () => Promise<ConfirmAttachReply> | ConfirmAttachReply,
): Promise<void> => {
  let reply: ConfirmAttachReply | undefined;
  let threw: unknown;
  try { reply = await fn(); } catch (e) { threw = e; }

  if (threw !== undefined) {
    check(what, false, `threw instead of replying: ${(threw as Error)?.message ?? threw}`);
    return;
  }
  if (reply?.ok !== false) { check(what, false, { accepted: reply }); return; }
  if (!ATTACH_REFUSALS.includes(reply.error ?? "")) {
    check(what, false, { unknownRefusal: reply.error }); return;
  }
  check(what, reply.error === expected, { wanted: expected, got: reply.error });
};

const DIGEST = "sha256:" + "ab".repeat(32);
const OTHER_DIGEST = "sha256:" + "cd".repeat(32);
const RACE_A = "sha256:" + "1a".repeat(32);
const RACE_B = "sha256:" + "1b".repeat(32);
const base: ConfirmAttachArgs = { digest: DIGEST, channel: "general", seq: 1 };

const SPACE = "main";
const OWNER = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_OWNER = "UBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ACTOR = "agent";
const CALLER = `${OWNER}.${ACTOR}`;
const LC = "01h" + "z".repeat(22) + "a";

const artifactPart = (digest: string) =>
  ({ kind: ARTIFACT_PART_KIND, name: "f.bin", mediaType: "application/octet-stream", digest, size: 3 });
const msgWith = (parts: unknown[]): CotalMessage =>
  ({ id: "m", ts: 1, space: SPACE, from: { id: CALLER, name: "a", role: "r" },
     channel: "general", parts } as unknown as CotalMessage);

/**
 * Each fixture differs from the CONTROL in exactly ONE predicate, so a cell that reddens names the
 * check that fired. A fixture failing two predicates would pass its cell while proving nothing
 * about which one did the work.
 */
const ENTRIES: Record<number, { subject: string; msg: CotalMessage } | null> = {
  1: { subject: chatSubject(SPACE, OWNER, ACTOR, "general"), msg: msgWith([artifactPart(DIGEST)]) },
  2: { subject: chatSubject(SPACE, OWNER, ACTOR, "general"), msg: msgWith([{ kind: "text", text: "hi" }]) },
  3: { subject: chatSubject(SPACE, OWNER, ACTOR, "general"), msg: msgWith([artifactPart(DIGEST)]) },
  4: { subject: chatSubject(SPACE, OTHER_OWNER, ACTOR, "general"), msg: msgWith([artifactPart(DIGEST)]) },
  5: { subject: chatSubject(SPACE, OWNER, ACTOR, "general"), msg: msgWith([artifactPart(DIGEST)]) },
  6: { subject: chatSubject(SPACE, OWNER, ACTOR, "general"), msg: msgWith([artifactPart(DIGEST)]) },
  // ---- THE DISAGREEING FIXTURE, and the suite had nothing like it -------------------------------
  // Published on `#public`; the PAYLOAD claims `#secret`. Every other fixture in this file sets the
  // two to the same value, so the check that reads the subject and the bug that reads the payload
  // produced identical results everywhere — mutating `parsed.rest` to `entry.msg.channel` survived
  // all eleven cells, beside a long comment explaining why that must never happen.
  //
  // A fixture in which the bug is unobservable, with the bug documented next to it.
  7: {
    subject: chatSubject(SPACE, OWNER, ACTOR, "public"),
    msg: { ...msgWith([artifactPart(DIGEST)]), channel: "secret" } as CotalMessage,
  },
  // ---- ANOTHER PRINCIPAL'S ENTRIES, in the shapes a prober would use ----------------------------
  // Each differs in exactly the property the fine-grained refusals used to reveal: which channel it
  // was published to, whether it carries an artifact at all, and which digest that artifact is.
  8: { subject: chatSubject(SPACE, OTHER_OWNER, ACTOR, "secret"), msg: msgWith([artifactPart(DIGEST)]) },
  9: { subject: chatSubject(SPACE, OTHER_OWNER, ACTOR, "general"), msg: msgWith([{ kind: "text", text: "hi" }]) },
  10: { subject: chatSubject(SPACE, OTHER_OWNER, ACTOR, "general"), msg: msgWith([artifactPart(OTHER_DIGEST)]) },
  // ---- TWO ARTIFACT PARTS, on a channel of its own ---------------------------------------------
  // `Part[]` never restricted a message to one artifact, but every fixture above carries at most
  // one — so `find(isArtifactPart)` taking the FIRST part looked identical to matching the RIGHT
  // part, and the second attachment being unconfirmable was invisible.
  // Its own channel (`multi`), because the CONTROL below counts rows on `general` and a fixture that
  // quietly moves another cell's count is a fixture that can make it pass for the wrong reason.
  11: {
    subject: chatSubject(SPACE, OWNER, ACTOR, "multi"),
    msg: { ...msgWith([artifactPart(DIGEST), artifactPart(OTHER_DIGEST)]), channel: "multi" } as CotalMessage,
  },
  // Carries both race digests so the race cells need only one entry, on a channel of their own.
  12: {
    subject: chatSubject(SPACE, OWNER, ACTOR, "race"),
    msg: { ...msgWith([artifactPart(RACE_A), artifactPart(RACE_B)]), channel: "race" } as CotalMessage,
  },
};

const attachments: { digest: string; channel: string; lc: string }[] = [];
const deps = (over: Partial<ConfirmAttachDeps> = {}): ConfirmAttachDeps => ({
  async entryBySeq(seq) { return ENTRIES[seq] ?? null; },
  async liveLifecycleFor() { return LC; },
  // seq 3 is the no-possession fixture; every other seq possesses.
  async hasPossession() { return true; },
  async putAttachment(digest, channel, row) {
    const had = attachments.some((a) => a.digest === digest && a.channel === channel);
    if (!had) attachments.push({ digest, channel, lc: row.attacherLifecycleUid });
    return !had;
  },
  async dropAttachment(digest, channel) {
    const i = attachments.findIndex((a) => a.digest === digest && a.channel === channel);
    if (i >= 0) attachments.splice(i, 1);
  },
  now() { return 1; },
  ...over,
});
const run = (args: ConfirmAttachArgs, over?: Partial<ConfirmAttachDeps>) =>
  confirmAttach(args, CALLER, deps(over));

console.log("confirmAttach refusal suite\n");

// ---- A1 — the seq names no entry, COLLAPSED ----------------------------------------------------
// It used to refuse a distinct `entry not found`, which let any caller walk seqs and learn the chat
// stream's head position with no read ACL anywhere. Ownership cannot be determined for an entry
// that does not exist, so it cannot be safely distinguished — one name.
await refuses("A1 a seq past the stream head refuses with the COLLAPSED name, not `entry not found`",
  ATTACH_REFUSAL.notYours,
  () => run({ ...base, seq: 999_999_999 }));

// ---- A3 — the SUBJECT channel disagrees -------------------------------------------------------
// The comparison is against the subject-parsed channel, never the payload's `msg.channel`. Deleting
// this check would let the confirm ARGUMENT decide the scope — a caller-declared scope, which is
// exactly what §4.1 refuses and what the whole possession design exists to avoid.
// The expectation is the COLLAPSED name — see S1. What this cell still pins is that the predicate
// REFUSES AT ALL: delete the compare and the confirm succeeds, which no collapsed name can hide.
await refuses("A3 confirming an entry published to another channel is REFUSED, under the collapsed name",
  ATTACH_REFUSAL.notYours,
  () => run({ ...base, channel: "other-channel" }));

// ---- A3-payload — THE SUBJECT WINS, and this is the pair that proves it ------------------------
// Entry 7 is published on `#public` while its payload claims `#secret`. The two cells below are a
// matched pair: one must REFUSE and one must SUCCEED, and swapping the compare to `msg.channel`
// flips BOTH. A single cell here would be killable by a mutation that simply refuses everything.
await refuses("A3-payload naming the PAYLOAD's channel is refused — the payload does not decide scope",
  ATTACH_REFUSAL.notYours,
  () => run({ digest: DIGEST, channel: "secret", seq: 7 }));
{
  const reply = await run({ digest: DIGEST, channel: "public", seq: 7 });
  check("A3-subject naming the SUBJECT's channel SUCCEEDS — the broker-locked subject is the scope",
    reply.ok === true, reply);
}

// ---- A4 — no artifact part --------------------------------------------------------------------
await refuses("A4 a text-only entry is REFUSED, under the collapsed name",
  ATTACH_REFUSAL.notYours,
  () => run({ ...base, seq: 2 }));

// ---- A5 — the entry carries no part with this digest -------------------------------------------
await refuses("A5 confirming a digest the entry does not carry is REFUSED, under the collapsed name",
  ATTACH_REFUSAL.notYours,
  () => run({ ...base, digest: OTHER_DIGEST }));

// ---- A5-multi — TWO artifact parts, and the SECOND one must be confirmable ----------------------
// `find(isArtifactPart)` took the first artifact part and compared only ITS digest, so the second
// attachment of a two-artifact message was refused against its sibling's digest and could never be
// confirmed. `Part[]` carries no one-artifact restriction, so this is a reachable shape and not a
// hypothetical. The matched cell below it is what stops the fix from becoming "accept anything".
{
  const first = await run({ digest: DIGEST, channel: "multi", seq: 11 });
  check("A5-multi the FIRST artifact part of a two-artifact entry confirms",
    first.ok === true, first);
  const second = await run({ digest: OTHER_DIGEST, channel: "multi", seq: 11 });
  check("A5-multi2 and so does the SECOND — it is not compared against its sibling's digest",
    second.ok === true, second);
}
await refuses("A5-multi3 a THIRD digest the entry does not carry is still refused",
  ATTACH_REFUSAL.notYours,
  () => run({ digest: "sha256:" + "ef".repeat(32), channel: "multi", seq: 11 }));

// ---- A2 + A6 — COLLAPSED, and the collapse is the assertion ------------------------------------
// Two fixtures, ONE refusal. Asserting they produce the SAME name is the test; asserting each
// produces "some refusal" would pass against a verb that distinguishes them, which is the leak.
await refuses("A6 a digest with no possession row refuses `not authorized`",
  ATTACH_REFUSAL.notYours,
  () => run({ ...base, seq: 3 }, { async hasPossession() { return false; } }));
await refuses("A2 an entry published by ANOTHER principal refuses with the SAME name — collapsed",
  ATTACH_REFUSAL.notYours,
  () => run({ ...base, seq: 4 }));

// ---- A7 — ambiguous alias, ALLOWED to be distinct ----------------------------------------------
// An infrastructure fault rather than a fact about the store, so naming it leaks nothing.
// THE REAL CLASS, not `new Error("AmbiguousAclAlias")`. The first version threw a bare Error whose
// `name` is "Error" and whose message merely CONTAINED the words — so it passed against a bare
// `catch` that mapped every throw, including a dead broker, to this refusal. A fixture that can be
// satisfied by the wrong implementation is not testing the right one.
await refuses("A7 two live ACL rows for the alias refuse `AmbiguousAclAlias`, distinctly",
  ATTACH_REFUSAL.ambiguousAlias,
  () => run({ ...base, seq: 5 },
    { async liveLifecycleFor() { throw new AmbiguousAclAlias(CALLER, [LC, "01h" + "z".repeat(22) + "b"]); } }));

// ---- A7b — AND ANY OTHER FAULT IS NOT AN AMBIGUOUS ALIAS ---------------------------------------
// The companion that makes A7 mean something. A broker failure must NOT come back wearing an ACL
// refusal: it propagates, so the caller can tell "retry the transport" from "your alias is broken".
{
  let threw: unknown;
  try {
    await run({ ...base, seq: 5 }, { async liveLifecycleFor() { throw new Error("ECONNRESET"); } });
  } catch (e) { threw = e; }
  check("A7b an infrastructure fault PROPAGATES — it is not renamed as an ambiguous alias",
    threw instanceof Error && (threw as Error).message === "ECONNRESET",
    threw instanceof Error ? threw.message : threw);
}

// ---- THE SUCCESSION ORACLE — the adversary this suite could not previously construct ------------
//
// Every other fixture in this file models a foreign caller as a DIFFERENT ALIAS, which the sender
// compare rejects. That is not the adversary the design exists for. `artifact-attach.ts:166-169`
// says so in terms — the sender compare "is useless against SUCCESSION … a same-alias successor
// passes it trivially" — and then `:174-176` builds the fine-grained refusals on top of it, claiming
// the caller "has proven it published this entry". **Both cannot be true.** The suite could not see
// the contradiction because it never built a caller that is the same alias and a different
// incarnation, and a suite that cannot build the adversary cannot fail on it.
//
// TWO THINGS MAKE THIS BLOCK POSSIBLE, and the second is why it was missed for so long:
//  1. A same-alias caller whose LIVE lifecycle is the successor's.
//  2. A possession double keyed by LIFECYCLE. The `deps()` default returns a flat `true`, so the
//     fence — the one line the whole design rests on — could not distinguish an incarnation from
//     its predecessor no matter what the code did. The double was more forgiving than the store on
//     the ONE axis under test, so the fence's own cells measured nothing.
{
  const LC_SUCC = "01h" + "z".repeat(22) + "c";
  const seen: string[] = [];
  // FAITHFUL: the predecessor put the bytes, so only its lifecycle possesses them.
  const possession = async (_d: string, _p: string, lifecycleUid: string) => {
    seen.push(lifecycleUid);
    return lifecycleUid === LC;
  };
  const successor: Partial<ConfirmAttachDeps> =
    { async liveLifecycleFor() { return LC_SUCC; }, hasPossession: possession };

  const before = attachments.length;
  // The same five shapes as the foreign block below, asked by a caller the sender compare ADMITS.
  const probes = await Promise.all([
    run({ ...base, seq: 999_999_999 }, successor),                          // does that seq exist?
    run({ digest: DIGEST, channel: "other-channel", seq: 1 }, successor),   // which channel is it on?
    run({ digest: DIGEST, channel: "general", seq: 2 }, successor),         // does it carry an artifact?
    run({ digest: OTHER_DIGEST, channel: "general", seq: 1 }, successor),   // is it THIS digest?
    run({ ...base, seq: 1 }, successor),                                    // well-formed, not possessed
  ]);
  const distinct = new Set(probes.map((p) => `${p.ok}|${p.error}`));
  check("S1 SUCCESSOR PROBES ARE INDISTINGUISHABLE — a respawn learns nothing about its predecessor's entry",
    distinct.size === 1, [...distinct]);
  check("S1b and that one reply is the collapsed refusal",
    probes.every((p) => p.ok === false && p.error === ATTACH_REFUSAL.notYours), probes);
  check("S1c no successor probe wrote an attachment row — the COUNT did not move, on ANY channel",
    attachments.length === before, { before, after: attachments.length });

  // S1-pre — THE PRECONDITION, ASSERTED POSITIVELY, because the collapsed reply can no longer say
  // why it refused. Without this, a fixture whose `liveLifecycleFor` override silently failed to
  // apply would produce five identical PASSES for the wrong reason.
  check("S1-pre the fence really resolved the SUCCESSOR's lifecycle, not the predecessor's",
    seen.length > 0 && seen.every((l) => l === LC_SUCC), seen);

  // S1-CONTROL — the same faithful double, one predicate changed: the caller is the incarnation that
  // actually put the bytes. It must SUCCEED. A `hasPossession` stuck at `false` would satisfy every
  // cell above while proving nothing, and this is the arm that cannot pass if it is.
  const reply = await run({ digest: DIGEST, channel: "public", seq: 7 },
    { async liveLifecycleFor() { return LC; }, hasPossession: possession });
  check("S1-CONTROL the PREDECESSOR — same double, same entry, its own lifecycle — SUCCEEDS",
    reply.ok === true, reply);
}

// ---- THE SWEEP RACE — the write must not resurrect what the sweep removed ----------------------
//
// The possession read and the attachment write are two separate round trips. A sweep landing between
// them removes the possession row AND the attachment row, and the write then RECREATES the
// attachment — resurrecting a swept digest, which the write's own comment promises it may never do.
// Reproduced on real KV by the review seat with no adversary and no unusual timing.
//
// Driven deterministically here by a possession dep that answers TRUE to the fence and FALSE to the
// confirming re-read, which is exactly the interleaving without the flakiness of provoking it.
{
  const flip = () => { let n = 0; return async () => (n++ === 0); };

  // R1/R2 — the race is LOST and the insert is undone.
  const lost = await run({ digest: RACE_A, channel: "race", seq: 12 }, { hasPossession: flip() });
  check("R1 a confirm whose possession is swept mid-write is REFUSED, under the collapsed name",
    lost.ok === false && lost.error === ATTACH_REFUSAL.notYours, lost);
  check("R2 and the row it inserted is GONE — the swept digest is not resurrected",
    !attachments.some((a) => a.digest === RACE_A), attachments.filter((a) => a.channel === "race"));

  // R3 — THE CONTROL. Same entry, same channel, possession that does NOT vanish. Without it, a
  // rollback that fired unconditionally would satisfy R1 and R2 perfectly.
  const kept = await run({ digest: RACE_A, channel: "race", seq: 12 });
  check("R3 CONTROL an unswept confirm still SUCCEEDS and keeps its row",
    kept.ok === true && attachments.some((a) => a.digest === RACE_A), kept);

  // R4 — AND A ROW WE DID NOT WRITE IS NOT COLLATERAL. The rollback is keyed on whether THIS call
  // inserted, not on whether possession vanished: a confirm that finds an existing row resurrected
  // nothing, and deleting it would turn a lost race into the destruction of a live attachment
  // belonging to some other principal's confirm. That is a worse outcome than the bug being fixed,
  // and it is the failure mode a naive "delete on lost race" would introduce.
  const seeded = await run({ digest: RACE_B, channel: "race", seq: 12 });
  check("R4-pre a first confirm writes the row", seeded.ok === true, seeded);
  const second = await run({ digest: RACE_B, channel: "race", seq: 12 }, { hasPossession: flip() });
  check("R4 a repeat confirm that loses the race leaves the PRE-EXISTING row alone",
    attachments.some((a) => a.digest === RACE_B), attachments.filter((a) => a.channel === "race"));
  check("R4b and it does not report a failure it did not cause", second.ok === true, second);
}

// ---- THE STRUCTURE ORACLE, CLOSED — asserted as an INDISTINGUISHABILITY -------------------------
//
// A foreign caller probing another principal's entries used to get a different name for each shape:
// which seq exists, which channel it was on, whether it carried an artifact, whether a guessed
// digest matched. Those names were right as daemon AUDIT events with no caller; on
// `ControlReply.error` they answer anyone holding the delivery control rail, with no read ACL on the
// channel involved.
//
// The property is that the replies are THE SAME, so it is asserted as a set of size one across the
// probe shapes — not as five separate "this one says notYours" cells, which would all pass against
// an implementation that leaked through a sixth shape.
{
  // Taken BEFORE the probes and asserted after. The previous form asked whether any row had landed
  // on `secret`, under a name that quantifies over ALL rows — so an unauthorized write to any THIRD
  // channel was invisible to all seventeen cells: a mutation that kept every reply collapsed and
  // wrote a row to `public` left the suite at 17/17. A count that must not move covers the channels
  // nobody has thought of, which is the whole point of a block written against "a sixth shape".
  const before = attachments.length;
  const probes = await Promise.all([
    run({ ...base, seq: 999_999_999 }),                            // does that seq exist?
    run({ digest: DIGEST, channel: "secret", seq: 8 }),            // which channel is it on?
    run({ digest: DIGEST, channel: "general", seq: 9 }),           // does it carry an artifact?
    run({ digest: DIGEST, channel: "general", seq: 10 }),          // is it THIS digest?
    run({ ...base, seq: 4 }),                                      // a well-formed foreign entry
  ]);
  const distinct = new Set(probes.map((p) => `${p.ok}|${p.error}`));
  check("FOREIGN PROBES ARE INDISTINGUISHABLE — every shape returns one identical reply",
    distinct.size === 1, [...distinct]);
  check("and that one reply is the collapsed refusal",
    probes.every((p) => p.ok === false && p.error === ATTACH_REFUSAL.notYours), probes);
  check("no foreign probe wrote an attachment row — the COUNT did not move, on ANY channel",
    attachments.length === before, { before, after: attachments.length, attachments });
}

// ---- CONTROL — without this the refusals above are unfalsifiable --------------------------------
{
  let reply: ConfirmAttachReply | undefined;
  let threw: unknown;
  try { reply = await run({ ...base, seq: 6 }); } catch (e) { threw = e; }
  check("CONTROL a well-formed publish-then-confirm SUCCEEDS",
    threw === undefined && reply?.ok === true,
    threw !== undefined ? `threw: ${(threw as Error)?.message}` : reply);
  // TWO rows now, not one: the A3-subject cell above is also a successful confirm. Counted by
  // CHANNEL rather than by length, so adding a future success cell cannot silently satisfy this.
  check("CONTROL and it wrote exactly one attachment row for `general`",
    attachments.filter((a) => a.channel === "general").length === 1, attachments);
  check("CONTROL recording the LIFECYCLE, never the alias — pin must not be satisfiable by a successor",
    attachments.every((a) => a.lc === LC), attachments);
}

// ---- the vocabulary is closed and unambiguous --------------------------------------------------
// Two predicates sharing a refusal string by accident would make one of them untestable — the
// helper could never tell which fired. The A2/A6 collapse is the ONE intended sharing.
{
  const values = Object.values(ATTACH_REFUSAL);
  check("the refusal vocabulary has no accidental duplicates",
    new Set(values).size === values.length, values);
}

console.log(`\nartifact-attach: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
