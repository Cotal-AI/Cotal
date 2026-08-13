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
import { ATTACH_REFUSAL, ATTACH_REFUSALS, confirmAttach, type ConfirmAttachArgs, type ConfirmAttachReply }
  from "../src/artifact-attach.js";

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

console.log("confirmAttach refusal suite\n");

// ---- A1 — the seq names no entry --------------------------------------------------------------
await refuses("A1 a seq past the stream head refuses `entry not found`",
  ATTACH_REFUSAL.entryNotFound,
  () => confirmAttach({ ...base, seq: 999_999_999 }));

// ---- A3 — the SUBJECT channel disagrees -------------------------------------------------------
// The comparison is against the subject-parsed channel, never the payload's `msg.channel`. Deleting
// this check would let the confirm ARGUMENT decide the scope — a caller-declared scope, which is
// exactly what §4.1 refuses and what the whole possession design exists to avoid.
await refuses("A3 confirming an entry published to another channel refuses `channel mismatch`",
  ATTACH_REFUSAL.channelMismatch,
  () => confirmAttach({ ...base, channel: "other-channel" }));

// ---- A4 — no artifact part --------------------------------------------------------------------
await refuses("A4 a text-only entry refuses `no artifact part`",
  ATTACH_REFUSAL.noArtifactPart,
  () => confirmAttach({ ...base, seq: 2 }));

// ---- A5 — the part references a different digest -----------------------------------------------
await refuses("A5 confirming a digest the entry does not carry refuses `digest mismatch`",
  ATTACH_REFUSAL.digestMismatch,
  () => confirmAttach({ ...base, digest: OTHER_DIGEST }));

// ---- A2 + A6 — COLLAPSED, and the collapse is the assertion ------------------------------------
// Two fixtures, ONE refusal. Asserting they produce the SAME name is the test; asserting each
// produces "some refusal" would pass against a verb that distinguishes them, which is the leak.
await refuses("A6 a digest with no possession row refuses `not authorized`",
  ATTACH_REFUSAL.notYours,
  () => confirmAttach({ ...base, seq: 3 }));
await refuses("A2 an entry published by ANOTHER principal refuses with the SAME name — collapsed",
  ATTACH_REFUSAL.notYours,
  () => confirmAttach({ ...base, seq: 4 }));

// ---- A7 — ambiguous alias, ALLOWED to be distinct ----------------------------------------------
// An infrastructure fault rather than a fact about the store, so naming it leaks nothing.
await refuses("A7 two live ACL rows for the alias refuse `AmbiguousAclAlias`, distinctly",
  ATTACH_REFUSAL.ambiguousAlias,
  () => confirmAttach({ ...base, seq: 5 }));

// ---- CONTROL — without this the refusals above are unfalsifiable --------------------------------
{
  let reply: ConfirmAttachReply | undefined;
  let threw: unknown;
  try { reply = await confirmAttach({ ...base, seq: 6 }); } catch (e) { threw = e; }
  check("CONTROL a well-formed publish-then-confirm SUCCEEDS",
    threw === undefined && reply?.ok === true,
    threw !== undefined ? `threw: ${(threw as Error)?.message}` : reply);
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
