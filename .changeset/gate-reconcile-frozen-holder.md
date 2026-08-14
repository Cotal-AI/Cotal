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
