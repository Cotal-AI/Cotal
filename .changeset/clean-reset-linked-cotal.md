---
"@cotal-ai/cli": patch
---

`clean store`, `clean all` and the other `clean` targets that remove files, their dry runs, and both
`reset` routes with their previews now refuse in a folder whose `.cotal` is a link. The refusal is
`CONFLICT` (exit 2), or `TARGET_NOT_FOUND` for a link that leads nowhere, and nothing is read or
removed through the link. A dry run used to list removals through the link, a reset reported an
unknown outcome, and `clean` in a folder whose `.cotal` led nowhere removed the store of the project
folder above it.
