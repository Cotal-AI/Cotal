---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
---

Move the auth plane's retirement rail off the retired `ctl` surface onto the endpoint subjects

The auth plane served its generic "retire a lifecycle" operation on
`ctl.auth-admin.<owner>.<actor>`, a rail the spec retires in full and states must
not be handled. Rows written onto a deleted rail are defects rather than
exceptions to it, so the rail moves to
`ep.one.auth.retire-lifecycle.handle.<target triple>.<caller triple>.<nonce>`
instead of the cut growing a carve-out.

Two things get stronger on the way. The reply is now derived from the parsed
request, so there is no argument through which a caller- or payload-supplied
reply target could arrive; and the request and reply planes are disjoint, so the
listener credential cannot express a request subject at all. The per-despawn
requester credential now pins both its caller triple and exactly one target
incarnation, so a leaked requester cannot be re-aimed at another lifecycle.

Serve-time authorization additionally requires that the serve registration a
request names belongs to the requesting principal. The previous two-token
subject could not express the caller beyond a recyclable alias, so the rail
accepted any registered instance's registration. This is alias-level binding:
the registration is keyed by an id that is stable across restarts and carries no
lifecycle uid, so a same-principal predecessor presenting the current epoch is
still accepted.

The spec rows also described an authorization mechanism the implementation had
already replaced, and now describe what ships.

This is a subject-plane migration, not a completed endpoint migration. The rail
carries the endpoint subjects but still exchanges the pre-v0.4 request and reply
bodies, registers no service record, serves no `describe`, and has no contract
artifact — so a generic endpoint client can neither discover nor invoke the
command. That gap is tracked separately, with the acceptance test being that a
generic client can do both. The one acceptance-path hole is closed here rather
than deferred: the request carries an id, the reply echoes it, and a reply that
does not echo is refused, so a wrong-id success cannot clear a retirement hold.

The requester's grant pins its target with the `handle` mode, which is normatively
redemption-minted. This path is not: there is no issuer-signed artifact, no
redemption step, and no lineage — the row is built directly from the minting
manager's coordinates under root authority. It is used because it is the only
target mode that can pin an exact incarnation, and the serve-time handler
re-checks that triple against the current mapping. This is a documented
deviation, not compliant handle semantics, and it is stated at the mint site and
in the ownership matrix row. It resolves with the same tracked work as the
envelope, since the mode and the envelope are one wire-conformance surface.
