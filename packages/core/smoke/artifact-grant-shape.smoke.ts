/**
 * THE DELIVERY CREDENTIAL MAY NEVER HOLD WRITE ON THE POSSESSION INDEX.
 *
 * WHAT THIS GUARDS, IN ONE SENTENCE. Possession is EARNED by putting the bytes, and it is the only
 * thing `confirmAttach`'s succession fence reads. A delivery daemon that can WRITE possession can
 * manufacture it for any principal at any lifecycle — after which `confirmAttach` is a formality and
 * the tombstone semantics protect nothing. **The absence of one subject from one allow-list IS the
 * fence.**
 *
 * WHY THAT MAKES THIS SUITE NECESSARY RATHER THAN TIDY. Every other invariant in this slice is held
 * by code a compiler checks or a cell exercises. This one is held by a STRING NOT APPEARING IN AN
 * ARRAY. Nothing types it, nothing runs it, and the failure is silent and total.
 *
 * IT WAS BUILT BEFORE THE GRANT EXISTED, AND THAT HAS NOW BEEN PAID OUT. When this file landed the
 * delivery credential held NOTHING on either artifact bucket, which is why the wired control rail was
 * broker-denied under auth. The obvious plan was "whoever adds the grant must also write this cell" —
 * prose with no enforcement point, the very failure class this lane keeps filing. So the guard landed
 * FIRST, green, against that state:
 *
 *   **the change that widens the grant does not have to REMEMBER a guard — it has to GET PAST one.**
 *
 * IT WORKED, MEASURED. The grant fold was applied to `deliveryPermissions` and this suite was run
 * BEFORE any cell here was touched: G4 went red ALONE, with G2, G3 and all four negative controls
 * green. The author of the widening was stopped by a guard rather than trusted to recall one, and G4
 * below is that guard turned around to face the state it was waiting for.
 *
 * IT DRIVES THE SHIPPED BUILDER, NOT ITS SOURCE. `permissionsFor` is called for the `delivery`
 * profile and the returned object is inspected. A grep over `provision.ts` would prove something
 * about the text; this proves something about the grant a broker would receive.
 *
 * Run: pnpm smoke:artifact-grant-shape
 */
import { permissionsFor } from "../src/provision.js";
import { possessionBucket, attachmentBucket } from "../src/artifact-index.js";
import { membersBucket, chatStream } from "../src/subjects.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const SPACE = "grantshape";
const PR = { owner: "local", actor: "deliveryd", connId: "UTESTCONNID" };

const perms = permissionsFor("delivery", SPACE, PR, {}) as {
  pub?: { allow?: string[] };
  sub?: { allow?: string[] };
};
const pubAllow = perms.pub?.allow ?? [];

/** A `$KV.<bucket>` publish grant is WRITE on that bucket, in any of its subject forms. */
const grantsKvWrite = (allow: readonly string[], bucket: string): boolean =>
  allow.some((s) => s.startsWith(`$KV.${bucket}`));

const POSSESSION = possessionBucket(SPACE);
const ATTACHMENT = attachmentBucket(SPACE);

console.log(`delivery profile: ${pubAllow.length} pub.allow subjects\n`);

// ---- G1-CONTROL — THE ARM THAT MUST SUCCEED, and here it is load-bearing rather than ceremony ----
// Every other cell in this file asserts an ABSENCE, and **an absence is vacuously true against an
// empty list**. A builder that returned `{}` for this profile would satisfy G2, G3 and G4 perfectly
// while measuring nothing at all. This is the fourth time on this lane that the arm which must PASS
// is the only thing capable of detecting an instrument that has stopped touching its subject.
check("G1-CONTROL: the delivery grant set is REAL — a known-granted bucket write is present",
  grantsKvWrite(pubAllow, membersBucket(SPACE)) && pubAllow.length > 20,
  { subjects: pubAllow.length, members: membersBucket(SPACE) });

// ---- G2 — THE FENCE ------------------------------------------------------------------------------
check(`G2: the delivery credential holds NO write on the possession index (${POSSESSION})`,
  !grantsKvWrite(pubAllow, POSSESSION),
  pubAllow.filter((s) => s.startsWith(`$KV.${POSSESSION}`)));

// ---- G3 — THE ASYMMETRY, AS ONE CELL SO IT CANNOT BE SATISFIED BY WIDENING BOTH -------------------
// Stated as an IMPLICATION rather than as "attachment present AND possession absent". It was written
// that way because on the day it landed the attachment grant did not exist either, and **a guard that
// is red on arrival teaches everyone to ignore it.** It stays that way now that the grant does exist,
// because the implication is the invariant and the conjunction is only today's instance of it: G4
// asserts the attachment side, G2 the possession side, and this cell is what refuses the pairing
// itself — including on some future day when the attachment grant is withdrawn again.
//
// The invariant is the one that had to survive the grant being added: whatever the attachment bucket
// is given, possession must stay unwritable. A reviewer optimising for symmetry will propose matching
// grants on both buckets — THAT is the proposal this cell refuses.
const attachmentWrite = grantsKvWrite(pubAllow, ATTACHMENT);
const possessionWrite = grantsKvWrite(pubAllow, POSSESSION);
check("G3: ASYMMETRY — granting attachment write must never come with possession write",
  !(attachmentWrite && possessionWrite),
  { attachmentWrite, possessionWrite });

// ---- G4 — THE TRIPWIRE, FIRED AND TURNED AROUND ---------------------------------------------------
// This cell used to assert the attachment write grant was ABSENT. It was built to go red exactly once,
// on the change that added it, so that the author of the widening would be STOPPED by a guard rather
// than trusted to remember one. That happened: the fold landed in `deliveryPermissions`, this suite
// was run before any cell here was touched, and G4 went red alone with G2, G3 and every negative
// control still green.
//
// It now asserts the far side of the same transition. `confirmAttach` is the SINGLE attachment writer
// and the delivery daemon is the only principal that runs it, so losing this grant does not fail
// loudly — it makes the verb broker-denied for every caller, which is precisely the defect that
// shipped once already while the open-broker rail suite stayed green.
check(`G4: the attachment index WRITE grant is present (${ATTACHMENT}) — confirmAttach cannot run without it`,
  attachmentWrite,
  pubAllow.filter((s) => s.startsWith("$KV.")));

// ---- G5/G6/G7 — THE THREE READS, one cell each because they fail INDEPENDENTLY --------------------
// Named separately rather than as one "the reads are present" cell: they sit on three different
// streams, are needed by three different steps of one call graph, and the attachment read is reached
// ONLY by a repeat confirm. A single collapsed cell would go green on two of three and hide the arm
// that is hardest to reach by accident.
//
// EXACT MATCH, not `startsWith`. `$JS.API.STREAM.MSG.GET.KV_cotal_artpossess_x` is a prefix of
// nothing here, but a `startsWith` check would also be satisfied by a wildcard row someone widens in
// later — and a wildcard is a different grant with the same look.
// Takes the list as an ARGUMENT rather than closing over `pubAllow`, so the negative controls below
// can drive the SAME function over a synthetic list. A control that re-implements the predicate it is
// controlling proves the copy works, not the original.
const grants = (allow: readonly string[], subject: string): boolean => allow.includes(subject);
const CHAT = chatStream(SPACE);

check(`G5: the CHAT entry get is granted (${CHAT}) — confirmAttach's FIRST call, and where it died`,
  grants(pubAllow, `$JS.API.STREAM.MSG.GET.${CHAT}`), pubAllow.filter((s) => s.includes("STREAM.MSG.GET")));

// The read that must exist alongside G2's absent write: possession is READ-ONLY to this credential,
// and "read-only" is two claims, not one. G2 alone is satisfied by a credential that cannot see the
// bucket at all — which is a broken daemon, not a safe one.
check(`G6: the possession READ is granted (${POSSESSION}) — the fence must be readable to be a fence`,
  grants(pubAllow, `$JS.API.STREAM.MSG.GET.KV_${POSSESSION}`), pubAllow.filter((s) => s.includes(POSSESSION)));

check(`G7: the attachment READ is granted (${ATTACHMENT}) — putAttachmentIfAbsent's confirming get`,
  grants(pubAllow, `$JS.API.STREAM.MSG.GET.KV_${ATTACHMENT}`), pubAllow.filter((s) => s.includes(ATTACHMENT)));

// ---- G8 — WHAT IS NOT GRANTED, and it is not pedantry ---------------------------------------------
// `Kvm.open()` binds (`bindOnly`), so it never calls `streams.info` and `kv.get` never takes the
// direct path. A `STREAM.INFO` or `DIRECT.GET` row on either index bucket would therefore be a grant
// for a call that is never made — and the way least-privilege actually erodes is one plausible,
// unexercised subject at a time. If a client upgrade makes either call real, this cell goes red and
// the row gets added deliberately, with its reason.
const grantsDeadIndexRow = (allow: readonly string[]): boolean =>
  allow.some((s) =>
    s === `$JS.API.STREAM.INFO.KV_${POSSESSION}` || s === `$JS.API.STREAM.INFO.KV_${ATTACHMENT}` ||
    s.startsWith(`$JS.API.DIRECT.GET.KV_${POSSESSION}`) || s.startsWith(`$JS.API.DIRECT.GET.KV_${ATTACHMENT}`));

check("G8: no STREAM.INFO or DIRECT.GET row on either index bucket — bind-only makes both dead grants",
  !grantsDeadIndexRow(pubAllow),
  pubAllow.filter((s) => s.includes("STREAM.INFO") || s.includes("DIRECT.GET")));

// ---- NEGATIVE CONTROLS — because an unfired guard and an absent guard are indistinguishable -------
// G2, G3 and G4 are designed never to fire in normal operation. That is exactly the condition under
// which a guard rots without anyone noticing: it reports success forever, whether or not it still
// works. Each predicate is therefore driven against a SYNTHETIC allow-list carrying the forbidden
// subject, proving it can still bite.
{
  const planted = [...pubAllow, `$KV.${POSSESSION}.>`];
  check("NEGATIVE CONTROL: G2's predicate REDDENS when a possession write subject is planted",
    grantsKvWrite(planted, POSSESSION));

  const both = [...pubAllow, `$KV.${POSSESSION}.>`, `$KV.${ATTACHMENT}.>`];
  check("NEGATIVE CONTROL: G3's predicate REDDENS when BOTH buckets are granted write",
    grantsKvWrite(both, ATTACHMENT) && grantsKvWrite(both, POSSESSION));

  // G4 now asserts PRESENCE, so its control is the other direction: strip the row and the predicate
  // must go false. A presence cell that cannot fail is a cell that has stopped reading the array.
  check("NEGATIVE CONTROL: G4's predicate REDDENS when the attachment write grant is stripped",
    !grantsKvWrite(pubAllow.filter((s) => !s.startsWith(`$KV.${ATTACHMENT}`)), ATTACHMENT));

  // G5/G6/G7 run through `grants`, an EXACT match — driven here over synthetic lists, through the
  // SAME function, so these controls cannot drift away from the cells they control.
  const inCHAT = `$JS.API.STREAM.MSG.GET.${chatStream(SPACE)}`;
  check("NEGATIVE CONTROL: G5/G6/G7's detector REDDENS when the exact row is stripped from the list",
    !grants(pubAllow.filter((s) => s !== inCHAT), inCHAT));
  // The row a later widening would most plausibly introduce instead. It is a strictly BROADER grant,
  // so a `startsWith`/`some` detector would accept it and report a least-privilege row that is not
  // there. Exactness is the property being controlled.
  check("NEGATIVE CONTROL: a wildcard does NOT satisfy the detector standing in for the exact row",
    !grants(["$JS.API.STREAM.MSG.GET.>", "$JS.API.STREAM.MSG.GET.KV_x"], inCHAT));

  // G8 asserts an ABSENCE, so it gets G2's treatment: plant each forbidden form and drive the REAL
  // predicate over it. Both forms, because they are different shapes — `STREAM.INFO` is matched
  // exactly and `DIRECT.GET` by prefix (its subject carries the key).
  check("NEGATIVE CONTROL: G8's predicate REDDENS on a planted possession STREAM.INFO row",
    grantsDeadIndexRow([...pubAllow, `$JS.API.STREAM.INFO.KV_${POSSESSION}`]));
  check("NEGATIVE CONTROL: G8's predicate REDDENS on a planted attachment DIRECT.GET row",
    grantsDeadIndexRow([...pubAllow, `$JS.API.DIRECT.GET.KV_${ATTACHMENT}.$KV.${ATTACHMENT}.k`]));

  // And the discriminating half: the detector must not fire on a bucket that merely SHARES A PREFIX.
  // `cotal_artattach_<space>` and `cotal_artpossess_<space>` are different buckets; a sloppy
  // `includes("artifact")` or a prefix that stopped one character short would conflate them and make
  // G2 pass while possession was writable through its neighbour's name.
  check("NEGATIVE CONTROL: the detector does NOT confuse the two artifact buckets",
    !grantsKvWrite([`$KV.${ATTACHMENT}.>`], POSSESSION) && !grantsKvWrite([`$KV.${POSSESSION}.>`], ATTACHMENT),
    { POSSESSION, ATTACHMENT });
}

console.log(`\nartifact-grant-shape: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
