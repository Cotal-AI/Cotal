---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/delivery": minor
---

Artifact bytes now sit behind a registered store. Core adds the `artifact-store` extension kind
and its contract (`ArtifactStore`, `ArtifactStoreSpace`): verified put, stat, ranged read, a
two-step removal and a names-only inventory. The delivery daemon's handlers and sweep reach the
bytes only through it, and today's object code is its first store, `jetstream`, moved as it is.
Workspace adds the per-space binding (`ARTIFACT_STORE_BINDING_KIND`, `readArtifactStoreBinding`):
one key beside the artifacts endpoint material, read once when the daemon starts. No binding
means `jetstream`. A binding that is not a store name, or names an unregistered store, stops the
delivery daemon before it connects, with no fallback. Nothing on the wire changes.
