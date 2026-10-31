---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Use one persona catalog reader for core and the CLI. Preserve strict CLI directory errors and share its encoding, non-regular-file and symbolic-link metadata. Core's existing forgiving listing remains empty for unreadable catalogs, including directories that cannot be searched; manager replies retain their ownership filtering.
