---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

A remote manager now verify-evicts its credential family through its host with one maintenance request per 256 holders instead of one per holder. The `evict-family-principal` request carries `principals`, 1 to 256 distinct holders, in place of `principal`, and the result carries `evictions`, one `EvictionResult` per principal in request order, in place of `eviction`. The host reads the caller's `epcred.manager.<instanceId>` family once per request, refuses the request when any named holder is outside it, and evicts the set in one `evictPrincipals` sweep. Before, each restart cost one host request, one family read, one credential mint and one daemon sweep per holder, so the host's work grew with holders times family rows. `registerRemoteManagerAuthority` now takes an `evict` that answers one verdict per holder for a set, `makeDeliveryAdminHolderEvictor` answers one `EvictionResult` per holder, and the registration barrier's `evictMax` option is removed, since every evictor now takes up to `EVICT_PRINCIPALS_MAX` holders per call. A remote manager and its issuing host must upgrade together.
