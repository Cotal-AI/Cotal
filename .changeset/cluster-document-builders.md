---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

`@cotal-ai/core` exports `buildClusterDocument(urn, revision, rows)` and `buildClusterArtifacts(document)` beside `ClusterDocument`. `authClusterDocument`, `authClusterArtifacts`, `managerClusterDocument` and `managerClusterArtifacts` call these builders instead of carrying duplicate row-to-document mappings, inline `ClusterDocument` return types and single-document closure artifact wrappers. Every produced cluster document, root digest, manifest and closure digest is unchanged.
