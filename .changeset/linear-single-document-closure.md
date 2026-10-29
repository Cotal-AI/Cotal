---
"@cotal-ai/linear": patch
---

`linearClusterDocument` and `linearClusterArtifacts` now build their single-document closure manifests and digests with `singleDocumentClosure` from `@cotal-ai/core`, matching the auth and manager service contracts. Every published artifact and digest is unchanged.
