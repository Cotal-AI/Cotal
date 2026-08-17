---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Stop `cotal ps` waiting on registrations whose host is gone, and give those registrations an exit.

A class scatter's gather has two exits: every frozen slot answered, or the deadline. The expected set
is frozen from the service registry, which records registration rather than liveness, and an instance
that crashes never deregisters, so its record goes on claiming a live instance for as long as the
bucket exists. That leaves a slot which can never answer, which makes the first exit unreachable, so
the deadline is paid in full on every scatter in the space, indefinitely. Measured on the laptop this
was built against: `cotal ps` at 12.5s with one true corpse in the set, ending in a row that read
`unreachable` for a machine that had been gone for weeks. There was no way to remove that record.
Three things were wrong, one per layer, and all three are fixed here.

**The scatter can now be told an instance is gone.** `epScatter` takes an optional `probeLiveness`
hook and ends the gather once every frozen slot has either produced a valid reply or been affirmed
gone. It moves the classification point and nothing else: an affirmed-gone slot is still `missing`,
still surfaced, still not `complete`, and a straggler arriving after an early finish is still reported
`late` rather than dropped. Only the verdict `gone` licenses anything; `live`, `unknown`, a hook that
throws, and any value outside the closed set all leave the full deadline standing, so a broken probe
degrades to exactly the previous behaviour rather than to a fast wrong answer. `epProbeInstanceInterest`
supplies that verdict from the broker itself: a `describe` cast on the instance's own rail with the
reserved no-responders sentinel as its reply-to, the same primitive and trust rule `epCall` already
relies on. A serving incarnation subscribes its instance rail for every command it serves and every
endpoint must serve `describe`, so silence on that rail is evidence of absence rather than absence of
evidence. The reply is never read, so an instance whose describe is broken still reads as present.

**And a probe is never a reason to still be running.** Against a live instance the probe is never
answered, because the request is a cast and a responder must not reply to one, so its deadline timer
runs the full budget on every healthy instance every time. Wired into `cotal ps` that was measured at
four extra seconds after the last row was printed, on a mesh with no dead registration in it at all:
12.8s with the probe against 8.8s with it switched off, same tree and same mesh. The timer is now
unref'd, so a probe still settles `unknown` at its budget for anyone waiting on it and no longer holds
the event loop open for a caller whose gather has already finished. The same measurement after the fix
is 8.6s to 9.4s.

**The probe belongs to the caller, not to the scatter.** Asking about an instance is a publish on that
instance's rail, and a credential holding no row for it is refused by the broker asynchronously while
the publish returns normally, so a refused probe is silent and silence is what a live but slow instance
looks like. Core cannot tell those apart because core does not know what the credential carries. So
`epScatterService` forwards a caller-supplied hook and never invents one, and the CLI supplies a closure
that returns `unknown` without publishing for any id outside its pinned set, and reports a refusal the
broker raises anyway instead of letting it expire into a timeout. That refusal is attributed to the
instance its own subject names, parsed as an exact route token, so one refusal is never charged to a
second frozen instance whose id happens to be a prefix of the refused one. `cotal ps` freezes the class on its
first connection, re-mints an instrument pinned to exactly the frozen ids, and resolves and scatters on
a second. `instancePinnedInstrumentCapabilities` accepts several ids as well as one; each still emits
its own concrete rows, so no wildcard instance is minted and the existing boundary on instance
addressing is unchanged.

**A registration now has an exit, in two explicit routes.** A manager that stops cleanly deletes its own
`svc` spec and status keys, so an instance that was shut down leaves no row behind; a manager that loses
its lease still tears down fail-closed and deliberately does not deregister, because at that point it is
not the authority on its own record. For the host that cannot cooperate, `cotal deregister-instance
--instance <id>` removes the record, on the same evidence the scatter acts on and no weaker: it asks the
instance first and refuses if it answers, refuses if the probe could not run at all, refuses if the
instance is merely quiet, and deletes both keys at the revisions it read only when the broker affirms
that nothing is subscribed on that instance's own rail. Silence is never the evidence, because a wedged
process still holds its subscriptions and an unanswered describe is what a dead host, a hung one and a
slow one all look like. A dead process holds no subscription, so a real corpse still deletes. Nothing
sweeps the registry on age or on silence. Registering over a deregistration tombstone now works on both
keys, so a deregistered instance re-registers normally on its next start, with its epoch advancing.

**Rows split by what was actually established.** A silent instance already printed as registered with
no answer rather than as unreachable. Now that a probe exists, the four cases behind that one sentence
are distinguished: a registration the broker affirms is gone says the registration is stale and prints
the command that removes it, a probe that was refused and one that was never sent each say so, because
both are facts about the command rather than about the instance, and asked-and-silent keeps the wording
it has, since a slow host and a wedged one are the same observation.

**And one layer down, the same shape.** The manager writes `.cotal/manager.pid` itself rather than
having it written by whatever spawned it, so a supervisor started by a container entrypoint, by cron, or
by hand is recorded like a detached `cotal up` is; the record is removed on a clean stop, and only while
it still names that process. Every reader now verifies the recorded pid is alive and is a supervisor
before trusting it, and a live pid that belongs to something else is reported as a stale record and
never signalled.

This does not help against an instance that is connected but not answering. A hung responder holds its
subscriptions and is indistinguishable from a slow one, so it still costs the full deadline, which is
the correct result, and the removal verb refuses it for the same reason rather than unregistering a
process that is still running. A scatter with no probe wired behaves exactly as before.
