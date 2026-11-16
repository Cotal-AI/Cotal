---
"@cotal-ai/core": minor
---

Agent files now refuse `cwd` and `worktree` frontmatter instead of silently ignoring the requested directory.
Set the directory on the spawn request with `--cwd`. Other unmodeled scalar hints still round-trip through `meta`.
