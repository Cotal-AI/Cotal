# Canonical caller renewal baseline

`smoke:endpoint-canonical-renewal:live` uses a REAL broker and stock native KV.
It composes the shipped holder prepare, challenge and activation APIs, caller
bearer authorization, issuer and validator, then `issueCallerConnection` twice
with the same validated bearer and nonce. It does not seed accepted rows or
implement an issuance model. The trusted host grants follow the existing native
authority fixture. No participant receives those grants or signing material.

CR01 through CR05 establish the first issuance, canonical accepted row, active
native evidence, source index, unexpired source and open policy head. The native
oracle precedes CR06. CR06 requires renewal to return. A rejection is a failing
normative predicate, not an expected-denial pass. CR07 through CR11 require the
same reference, byte-identical ceiling, successful original resolve and confirm,
no new material writes, current source and released policy head. CR12 runs during
cleanup even after failure. Setup or observation errors have their own label.
The summary distinguishes planned, attempted, successful and failed controls.

Test-only witnesses forward each observed method once, with the original
receiver and arguments, returning the original promise and retaining the
original value or error privately. The native issued handle is frozen, so a
plain forwarding facade observes its stage, release, resolve and confirm calls.
The KV witnesses observe get, create and update. Recording is bounded to 256
operations across the two invocations. Overflow is explicit and invalidates the
no-fresh-material control. Readbacks use original handles outside the witnessed
invocations. Output carries fixed labels, counts and equality booleans only.
Raw keys, nonces, identities, credentials and error messages or stacks stay
private. Original rejection identity is compared to the native create error.

## Supported setup

The first ordinary baseline at `cd5d37` passed CR01 and CR12, failed CR00,
and did not reach CR02, the native renewal oracle or CR06. Original issued53
was skipped in that job. Its raw result remains a setup failure, not renewal
RED. Source inspection found that the test requested only `increment` during
caller authorization. The maintained selection parser requires `describe` and
unique commands. This concrete unsupported input is not the observed unique
inner cause of the old CR00 failure.

The successor requests `describe` and `increment` during authorization. The
policy still decides only `increment`, because shipped authorization strips
`describe` before the policy decision and source write. No product guard changes.
Four fixed setup states cover caller authorization, bearer issuance, validation
and the CR02 predicate. Each starts `not-reached`, enters before its argument
construction or await, and returns after success. The existing catch marks an
entered boundary `threw` and retains the original exception without continuing.
The setup oracle prints these labels and states during finally. CR00 remains a
failure for a setup exception. A false CR02 predicate remains a CR02 failure.

Splitting issuance and validation keeps the original validator lookup before
the issuer await, its original receiver, and validation options after issuance.
Markers identify composite boundaries, not every internal predicate. The issue
boundary includes the validator method lookup that the original nested call
performed first. The predicate boundary includes property evaluation and the
original CR02 assertion. Fixed state assignments are additional observation,
not uninstrumented timing equivalence. No issuer token or caught error is printed.
The successor has not been executed, so neither corrected setup nor renewal
has a new verdict. All proof and execution holds below remain in force.

Lookup, fresh stage, committed evidence, active attempt, source index, rejected
canonical create and held policy are separate observations. None is assumed.
The native collision count recognizes structured codes 10071, 10164 and 10077;
other rejection codes remain unclassified. The projection counts acquired-held
and open-head update attempts and compares the acquired operation privately.
It does not observe every instruction inside hold release. A held policy after
a material write is observed debt, not a proven failed release attempt. Physical cleanup does not claim retirement of issued authority.

This is a native component baseline. It does not prove the hosted assignment
state or identify the cause of P3A09. Original 37, 48, 53 and 14 journal controls
remain unchanged. The new ordinary fail-fast live-job step precedes issued53,
so a failing focused baseline prevents that later step from running in this job.
Existing earlier controls and their recorded results are not regraded.

## Unfulfilled proof obligations

Real-path mutation admission is blocked by the maintained command safety
contract. Both the live script segment and REAL broker marker remain visible.
There is no runnable mutation config here. Renaming, relocating, wrapping,
concealing infrastructure, direct-run evasion or changing safety policy is not
part of this baseline. Zero current journal target mutations were measured.
Fourteen ordinary journal passes are not mutation or restoration proof.

The following named obligations remain unfulfilled and unexecuted. Ordinary
baseline and green runs await separate execution admission. Reversion, mutation
and restoration runs also require resolution of the real-path proof blocker:

- CR-PROOF01: observe actual baseline RED on CR06, with native lookup, branch,
  material-effect and original rejection evidence. A setup error is not this RED.
- CR-PROOF02: after a separately selected and reviewed repair, require focused
  green, CR01 through CR12, and unchanged original acceptance including issued53.
- CR-PROOF03: restore the bare-token shipped lookup in the repaired implementation
  and require the genuine caller path to fail on CR06 again. This needs sanctioned
  real-path proof admission. It cannot use a simulated store or copied algorithm.
- CR-PROOF04: restore repaired source and loaded artifacts, verify restoration,
  and require focused restored green. Source hashes alone do not prove loaded code.
- CR-PROOF05: prove the existing-generation resolve, confirm and no-fresh-material
  assertions notice their named implementation faults through the same genuine
  caller path, with exact assertion targeting and restored green.

No product correction is included or authorized before actual named baseline
RED and fresh selection. Ordinary publication and CI execution require separate
admission. Final repair acceptance and deployment remain held until all required
proof obligations are fulfilled. This document is not a safety-policy waiver.
