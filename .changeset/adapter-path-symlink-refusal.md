---
"@cotal-ai/workspace": patch
---

`cotal service add` now says plainly when a declared adapter path crosses a symlink, such as `--handler /bin/sh` or `--handler /usr/bin/python3` for the `exec-endpoint` preset. It names the link and what it points to, and its Next names the physical path to use instead. The refusal used to report the symlink's own mode, 0777, as if group or others could write it, and a symlinked file was refused as `DEPENDENCY_UNAVAILABLE`. A symlink on any part of the path now refuses as `PERMISSION_DENIED`, because a link could be repointed after the check.
