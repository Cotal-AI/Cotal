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
 * WHY IT IS BUILT BEFORE THE GRANT EXISTS, WHICH IS THE POINT. The delivery credential currently
 * holds NOTHING on either artifact bucket — measured, not assumed, and it is why the wired control
 * rail is broker-denied under auth. The obvious plan was "whoever adds the grant must also write this
 * cell". That is prose with no enforcement point, which is the very failure class this lane keeps
 * filing. So the guard lands FIRST, green, against today's state:
 *
 *   **the change that widens the grant does not have to REMEMBER a guard — it has to GET PAST one.**
 *
 * IT DRIVES THE SHIPPED BUILDER, NOT ITS SOURCE. `permissionsFor` is called for the `delivery`
 * profile and the returned object is inspected. A grep over `provision.ts` would prove something
 * about the text; this proves something about the grant a broker would receive.
 *
 * Run: pnpm smoke:artifact-grant-shape
 */
import { permissionsFor } from "../src/provision.js";
import { possessionBucket, attachmentBucket } from "../src/artifact-index.js";
import { membersBucket } from "../src/subjects.js";

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
// Stated as an IMPLICATION rather than as "attachment present AND possession absent", because the
// attachment grant does not exist yet either: written the other way this cell would be RED on the day
// it landed, and **a guard that is red on arrival teaches everyone to ignore it.**
//
// The implication is exactly the invariant that must survive the grant being added: whatever the
// attachment bucket is given, possession must stay unwritable. A reviewer optimising for symmetry
// will propose matching grants on both buckets — THAT is the proposal this cell refuses.
const attachmentWrite = grantsKvWrite(pubAllow, ATTACHMENT);
const possessionWrite = grantsKvWrite(pubAllow, POSSESSION);
check("G3: ASYMMETRY — granting attachment write must never come with possession write",
  !(attachmentWrite && possessionWrite),
  { attachmentWrite, possessionWrite });

// ---- G4 — A TRIPWIRE ON THE PENDING STATE, AND IT IS MEANT TO FIRE EXACTLY ONCE -------------------
// The attachment write grant is absent TODAY, which is why the control rail cannot run under auth.
// When it is legitimately added this cell goes RED — deliberately. It forces the author of that
// change to acknowledge the transition rather than satisfy G3 silently, and it is the reason G3
// cannot be quietly widened on both sides. **A guard designed never to fire in normal operation is
// the kind that rots undetected; this one is built to fire once, on the change that matters.**
//
// TO THE AUTHOR WHO JUST TURNED THIS RED: that is expected. Confirm G2 and G3 are still green, then
// update this cell to assert the attachment grant is PRESENT. Do not delete it, and do not touch G2.
check(`G4 TRIPWIRE: the attachment write grant is still absent (${ATTACHMENT}) — see the note above`,
  !attachmentWrite,
  pubAllow.filter((s) => s.startsWith(`$KV.${ATTACHMENT}`)));

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

  check("NEGATIVE CONTROL: G4's predicate REDDENS when the attachment grant appears",
    grantsKvWrite([...pubAllow, `$KV.${ATTACHMENT}.>`], ATTACHMENT));

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
