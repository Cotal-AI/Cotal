---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Give each agent launched from one checkout its own git worktree on a new branch, so agents working on the same repository no longer share one working tree.
The Manager serves `worktree`, granted where `make-dir` and `clone` are, and its contract advances to revision 59. It runs `git worktree add -b` on the Manager's host with the same git environment as `clone`, takes the branch name from the folder unless one is given and starts it at the checkout's HEAD unless a base is given, and answers `{ path, branch, base, head }`. An existing folder or branch is refused and left as it is, option-shaped input is refused before git runs, and a worktree that fails or runs past the caller's deadline is removed with its branch.
