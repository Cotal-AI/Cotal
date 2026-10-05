---
"@cotal-ai/auth": patch
---

`docs/embedding.md` now shows how a host builds `platformControl.host`. Registration reads the closure manifest `{ v: 1, root, members: [] }` at `clusterDigest` and the cluster document at its `root`, so `artifacts` carries both and `clusterDigest` is the digest of the manifest. `members` stays empty because single-document clusters are the only ones registered, and the instance id is a lifecycle token. A minimal one-command example built from `contractDigest`, `VOID_SCHEMA_DIGEST` and `mintLifecycleUid` is included. No behavior changes.
