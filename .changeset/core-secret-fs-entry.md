---
"@cotal-ai/core": patch
---

The `@cotal-ai/core/secret-fs` subpath no longer exposes `__setPublishLinkForTest`, the test-only seam that replaces how secret files are published. The subpath now serves the same secret and private-record writers the package root exports. `EMPTY_CONVERSATION_SELECTION` is frozen down to its arrays, like core's other exported collections.
