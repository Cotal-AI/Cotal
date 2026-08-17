---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

Refuse a class-queue split before the command runs, instead of reporting it afterwards.

An endpoint call resolves one incarnation and then invokes through a queue that may pick another.
Until now the caller was the only party that noticed: the mismatch was detected on the reply, by
which time the responder had already handled the request. That is why the error had to say it
proved nothing about whether the command ran — a check that runs after the effect is a report, not
a guard. In a multi-manager space it is how one spawn becomes several: the effect lands on A, the
caller bound to B is told the call failed, and the retry duplicates it.

A request now carries the incarnation the caller resolved against (`bind`, a new optional
`EndpointRequest` field), and a responder that is not that incarnation refuses at the pre-effect
seam — before args validation, before target resolution, and before the governed gate that can
consume a one-use payment proof. The refusal carries `ai.cotal.ep.bind-refused` and states that
the command did not run, so re-resolving and re-issuing is safe. `failed-precondition` when a
different instance received it, `expired` when the same instance is at another epoch: the epoch is
carried even on the instance rail, where the subject grammar has no token for it and a successor
incarnation would otherwise serve its predecessor's caller.

The block confers nothing. It can only make a responder the subject already reached refuse, so it
narrows and never widens, and attribution still comes from the reply subject — a refusal
attributed to the very incarnation the caller bound is incoherent and is rejected rather than
honored, so the marker cannot be used to claim an effect away. It is refused rather than ignored
where it has no reading: on `describe`, which is what produces a bind, and on the scatter rail,
which addresses every incarnation by construction.

A long-lived client recovers from the refusal instead of stranding on it. `invokeService` caches
its resolve, and its existing split recovery keyed on a thrown marker — which a refusal, being an
ordinary reply, never raises. It now keys on the reply too, drops the stale bind, and re-issues
the call **once for any command**, not only for one on the repeat-safe allowlist. That allowlist
exists because a split used to be detected after the responder had handled the request, so core
could not tell a duplicate-able effect from a repaired one and had to fail closed; a bind refusal
removes the uncertainty rather than working around it, so the re-issue is a first attempt.

The allowlist still governs everything else, and that is the half that keeps this safe. A
responder that predates the fence ignores the field and executes, so its reply proves nothing
about whether the command ran — and re-issuing on it would duplicate the effect. The re-issue is
therefore withheld from every reply that does not carry the refusal, and the refusal is checked
rather than believed: the bind it was computed against must be the one this request carried, and
the incarnation it claims to be must be the one the reply subject attributes it to. Both halves
are derivable by the caller, and neither is something an unfenced responder can produce by
accident. A refusal that fails either is `internal`, not a licence to try again.

A re-issue that cannot be resolved surfaces the refusal, not the resolve. Re-resolving goes back
to the registry, and an endpoint that has since retired answers nothing — so a stale handle used
to be met with a describe deadline ten seconds later, with the one fact that said the command had
not run discarded on the way. The refusal now surfaces, carrying its marker, with the resolve
failure named as the reason the repair could not be attempted.

That recovery is counted, and the counter is the point. Handling a split makes it invisible, and
the routing event is the only evidence the split exists at all — silence it and the split rate
becomes unmeasurable exactly as it becomes survivable. `CotalEndpoint.splitRecoveryCount` is
always on and never behind a flag, and a `split-recovered` event carries the same fact for anyone
listening; the event can be missed, the count cannot. On a live two-manager mesh, 5 of 6 unpinned
class-anycast reads split, so this is not a rare-event counter.

The caller-side check remains, and remains necessary: a responder that predates the fence ignores
the field and executes, which leaves the older after-the-fact report — and the allowlist — as the
only protection in a skewed pair. That pair is now driven directly rather than argued about, by a
hand-rolled responder that answers the class rail without a fence; `serveEndpoint` cannot produce
the case, because its fence refuses a mismatched bind before the handler, so a request it executes
is one whose bind matched. `--on` still addresses a specific manager, but it is no longer what
stands between a split and a duplicated effect.

The suites count executions at the responder rather than publishes at the caller, and the change
was forced. "One publish" meant "one execution" only while a split was caught after the responder
had handled the request; under the fence the second publish carries the first execution, so the
old instrument reports a correctly repaired call and a duplicated one identically. Where a claim
narrowed, the cell says which condition moved it rather than being replaced.

SPEC §13.2 and §13.3 carry the normative rules; `docs/control-surface.md` is updated.
