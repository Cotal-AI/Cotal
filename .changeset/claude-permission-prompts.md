---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

The owner of a Claude agent launched in a permission mode that asks can now approve or deny its permission prompts from another session, while Claude's own dialog keeps working.

The first answer applies, and a denial's note reaches Claude as the reason. The connector holds each prompt on Claude's `PermissionRequest` hook and keeps one record per prompt in the new `cotal_permissions_<space>` bucket, which space setup creates and a restore recreates empty. Answers ride the new `cotal.<space>.perm.<agentOwner>.<agentActor>.<owner>.<actor>` rail, which only the owner's interactive principals may publish to, so no agent's credential can answer its own prompt or a sibling's. `CotalEndpoint` gains `openPermissionHolder`, `watchPermissions` and `answerPermission`, and the `approval` presence condition can name the held prompt in `request`. Every Manager `status.connectors` row now reports `permissionRequests`, and the Manager cluster advances to revision 49. On an open mesh, prompts stay with the terminal. See SPEC §8.2.
