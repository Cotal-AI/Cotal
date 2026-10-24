---
"@cotal-ai/cli": patch
---

A full `backup restore` or `up --restore` refused `CONFLICT` because the root's trust state moved,
such as after `clean all`, now names `cotal backup restore <dir> --only registry` in its Next when the
artifact holds the registry, which restores the channel settings with history starting empty.
