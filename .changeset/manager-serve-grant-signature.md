---
"@cotal-ai/auth": patch
---

The manager serve grant no longer takes a serve actor it never read. `reconstructRemoteManagerServeGrant` now takes the request, the owner and the observed gate, and `remoteManagerServeGrantFromCluster` no longer computes and discards the manager actors. The grant is unchanged: it is derived from the gate and the cluster document alone.
