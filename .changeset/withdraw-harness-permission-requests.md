---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
---

Withdraw harness permission requests, released in 0.165.0. A Claude Code connector no longer holds a permission prompt for its owner to answer from another session, so Claude Code's own dialog is the only way to answer one. This removes the `perm` answer subject, the `cotal_permissions_<space>` bucket and its readers, the `@cotal-ai/core/permissions` export, the `request` field on a presence condition and `permissionRequests` on a Manager `status.connectors` row. The Manager cluster advances to revision 51. A space set up on 0.165 keeps an unused, empty bucket.
