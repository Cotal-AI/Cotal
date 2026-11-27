---
"@cotal-ai/cli": patch
---

Reclaim protected unpublished `.extensions.stage-*` directories whose permissions are `0755` or user-private-group `0775`, and clean abandoned stages in the replaced connector set when `cotal update --self` finishes reconciling the newly installed CLI.
