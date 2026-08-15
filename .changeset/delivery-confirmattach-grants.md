---
"@cotal-ai/core": minor
---

Grant the scoped `delivery` credential the four broker subjects `confirmAttach` actually needs, and
keep possession value-write out.

The verb was served on the `ctl.delivery` rail without the authority its call graph requires. It
loads the published CHAT entry by sequence, reads possession twice, and creates/reads/deletes the
attachment row; the shipped allow-list granted none of it, so a real auth-mode request was denied at
`$JS.API.STREAM.MSG.GET.<CHAT stream>` before it ever reached the possession fence. The rail was
reachable and unusable at the same time.

`deliveryPermissions` now carries the CHAT entry get, the possession read, the attachment read, and
attachment write (create plus the lost-race rollback delete). Four subjects and no more: `Kvm.open`
binds rather than opens, so no `STREAM.INFO` row is needed on either index bucket, and the bound
client never takes the direct-get path, so `DIRECT.GET` rows would be grants for calls that are
never made.

**Possession value-write stays absent, and that absence is the fence.** Possession is earned by
putting the bytes and is the only thing the succession check reads; a delivery daemon that could
write it could manufacture possession for any principal at any lifecycle.

Why it was not caught: the existing rail suite runs its daemon on an open broker with full
authority. A test that holds every grant cannot measure an authorization boundary — it measures the
code path with that boundary removed, and it was green throughout. `smoke:artifact-rail-authz:auth`
is new and drives the verb end-to-end on the real minted delivery credential against a JWT-auth
broker, including the read/write asymmetry as an answer from nats-server rather than a string in an
array. No behavior changes for anyone not running the delivery daemon.
