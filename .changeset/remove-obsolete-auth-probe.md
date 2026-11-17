---
"@cotal-ai/auth": patch
"cotal-ai": patch
---

Remove an unused auth smoke probe that still expected Mesh manifests to deploy through spawn --file, keeping the maintained user-mode teardown suite as coverage.
