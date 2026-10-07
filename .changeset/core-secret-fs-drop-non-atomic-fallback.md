---
"@cotal-ai/core": patch
---

`writeSecretFileCreateOnly` now refuses with an `atomic-publish-unsupported` error when link publication is unavailable (ENOTSUP, EPERM, ENOSYS), removing the non-atomic in-place fallback that published the destination name before writing file bytes.
