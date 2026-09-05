---
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Add per-agent `cwd` to mesh manifests. Relative paths resolve on the manager host against its workspace, matching the imperative spawn option. The directory survives launch-spec validation and contributes to stale-entry detection without changing hashes for manifests that omit it.

This implements the working-directory part of #963. Manifest session continuity remains separate work.
