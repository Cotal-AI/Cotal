---
"@cotal-ai/cli": patch
---

A remotely provisioned spawn now launches under the incarnation uid the mesh
minted. The provisioning endpoint pre-creates the agent's lifecycle-keyed
durables and writes the ledger row under ITS `lifecycleUid`, and the auth
callout mints the agent's dm/dlv/chathist grants from that row — but the launch
kept the locally minted uid, so the agent asked for durables its credential did
not name and looped on bind violations, surfacing as "not connected to the
mesh" while the broker showed publish violations on `$JS.API.CONSUMER.INFO`.
The remote branch now adopts `material.lifecycleUid`, the same authority rule
already applied to the returned subscribe/allow lists.
