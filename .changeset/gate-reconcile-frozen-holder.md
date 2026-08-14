---
"@cotal-ai/core": minor
"@cotal-ai/delivery": minor
"@cotal-ai/manager": minor
---

Add a guarded way out of an issuance gate left frozen by a crashed manager restart.

When a manager restart is killed between deregistration and the successor's completion, the
endpoint's issuance gate is left frozen under a registration operation whose holder no longer
exists. Failing closed there is correct — it is what stops two incarnations serving at once — but
until now nothing could lift it, so every subsequent restart failed the same way and the only exits
were driving the internals by hand or discarding state.

`cotal reconcile-gate` verifies the freeze-holder is gone, logs what it found, and then completes
the dead operation exactly as the interrupted restart would have: revoke the credential family,
verify-evict its holders, and reopen the gate at the unchanged coordinate with the generation
advanced by one. It is a CLI command rather than a verb on the manager endpoint because the state
it repairs is precisely "the manager cannot complete registration" — an endpoint-served repair
would be unreachable exactly when it is needed.

The affirmative check required a read half that did not exist. The only principal-scoped liveness
was fused with the KICK inside `evictPrincipal`, so using it as a precheck would have killed a live
holder before anything could refuse on its behalf. This adds a read-only `principalLiveness`
delivery-admin verb (observer credential only, closed query, a reply bound to the exact principal
asked about) reporting `live` / `gone` / `unknown` with scan completeness kept separate. Its sweep
is the strict one the plane-liveness oracle already used — full reply validation plus the
single-server proof — now extracted and shared by both, so a probe can never be laxer than the
repair it authorizes.

Every refusal names its condition (`holder-alive`, `holder-unknown`, `liveness-unestablishable`,
`not-frozen`, `wrong-op-kind`, `no-gate`, `eviction-unverified`, `raced`). A timeout is
unknowability rather than death, the probe is a precondition on top of the barrier's own verified
eviction rather than a replacement for it, and there is no force flag and no path that discards
gate state.

Two defects in the shared `$SYS` scan surface were found while proving this and are fixed here,
because the guarded command is only as good as the observation it stands on.

A paginated CONNZ sweep could read a **lost later page as sweep-complete**. The first page comes
back full with more promised, the next round is silent or answers with an empty page while its own
total still says there is more, and the loop treated that as the end of the data. Since "complete
sweep, principal not found" is the definition of verified-gone, a connection living on the page that
was never delivered read as absent — so verified eviction could report gone for a principal that was
alive. Both the read-only observation and the scan/kick/re-scan primitive had the same shape, which
also meant the two of them were not the independent checks they looked like. A sweep now tracks
which servers still owe it a page and fails closed when one stops delivering; a sweep that genuinely
finishes across several pages still concludes gone, so nothing wedges.

The delivery daemon's `$SYS` sweeps were **not bound to the account it serves**. All three
delivery-admin executors resolved their scan account from the working directory at request time, and
the detached daemon inherits its launcher's directory for life — so a daemon started from a tree
that resolves a different mesh root would sweep a foreign account and answer a confident, wrong
"gone". The root is now pinned once at start, and the account read from disk is cross-checked
against the account the daemon's own credential authenticates as.
