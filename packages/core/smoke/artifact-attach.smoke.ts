/**
 * The `confirmAttach` refusal suite — every predicate named, and a CONTROL that succeeds.
 *
 * WHY EACH PREDICATE NEEDS ITS OWN NAME. Every failure here has the same observable: no attachment
 * row. That is a single bit, and a single bit cannot be a suite. Without distinct named refusals,
 * deleting the `channel` check leaves the suite green — some other check rejects the same fixture —
 * and that check is the one standing between us and a caller-declared scope, which is precisely what
 * §4.1 refuses.
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
};

const attachments: { digest: string; channel: string; lc: string }[] = [];
const deps = (over: Partial<ConfirmAttachDeps> = {}): ConfirmAttachDeps => ({
  async entryBySeq(seq) { return ENTRIES[seq] ?? null; },
  async liveLifecycleFor() { return LC; },
  // seq 3 is the no-possession fixture; every other seq possesses.
  async hasPossession() { return true; },
  async putAttachment(digest, channel, row) { attachments.push({ digest, channel, lc: row.attacherLifecycleUid }); },
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
await refuses("A3 confirming an entry published to another channel refuses `channel mismatch`",
  ATTACH_REFUSAL.channelMismatch,
  () => run({ ...base, channel: "other-channel" }));

// ---- A3-payload — THE SUBJECT WINS, and this is the pair that proves it ------------------------
// Entry 7 is published on `#public` while its payload claims `#secret`. The two cells below are a
// matched pair: one must REFUSE and one must SUCCEED, and swapping the compare to `msg.channel`
// flips BOTH. A single cell here would be killable by a mutation that simply refuses everything.
await refuses("A3-payload naming the PAYLOAD's channel is refused — the payload does not decide scope",
  ATTACH_REFUSAL.channelMismatch,
  () => run({ digest: DIGEST, channel: "secret", seq: 7 }));
{
  const reply = await run({ digest: DIGEST, channel: "public", seq: 7 });
  check("A3-subject naming the SUBJECT's channel SUCCEEDS — the broker-locked subject is the scope",
    reply.ok === true, reply);
}

// ---- A4 — no artifact part --------------------------------------------------------------------
await refuses("A4 a text-only entry refuses `no artifact part`",
  ATTACH_REFUSAL.noArtifactPart,
  () => run({ ...base, seq: 2 }));

// ---- A5 — the part references a different digest -----------------------------------------------
await refuses("A5 confirming a digest the entry does not carry refuses `digest mismatch`",
  ATTACH_REFUSAL.digestMismatch,
  () => run({ ...base, digest: OTHER_DIGEST }));

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
await refuses("A7 two live ACL rows for the alias refuse `AmbiguousAclAlias`, distinctly",
  ATTACH_REFUSAL.ambiguousAlias,
  () => run({ ...base, seq: 5 }, { async liveLifecycleFor() { throw new Error("AmbiguousAclAlias"); } }));

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
  check("no foreign probe wrote an attachment row", attachments.every((a) => a.channel !== "secret"),
    attachments);
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
