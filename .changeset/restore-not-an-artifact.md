---
"@cotal-ai/cli": patch
---

`backup restore` and `up --restore` of a file, an empty folder, a folder no backup create wrote, or
`.` in the folder they restore now refuse before they take the maintenance lock, naming the path
and what it is, where they used to exit 3 with an unconfirmed outcome. A file, or a folder that is
not an artifact, refuses `TARGET_NOT_FOUND`, and a path that is, holds or sits inside the preserved
store or `.cotal/maintenance` refuses `USAGE_INVALID`. `backup verify` and `backup inspect` now say
whether such a path is a file or an empty folder.
