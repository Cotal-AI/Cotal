---
"@cotal-ai/cli": patch
---

`clean all` now says in its dry run and its receipt that a full backup it leaves unrestorable still
restores its registry with `backup restore <dir> --only registry`, and that chat and DM history then
start empty. The docs say the same beside the backup restore rules and beside the identity rotation
that `auth mint` and `auth retire` recommend, which also leaves earlier full backups restoring only
their registry.
