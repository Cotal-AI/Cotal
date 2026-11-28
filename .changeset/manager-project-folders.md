---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Start a project on any computer in a new empty folder or a fresh clone of a git repository.
The Manager serves `make-dir` and `clone`, granted where `list-dir` is, and its contract advances to revision 59. `clone` takes an https, ssh or `user@host:path` URL and an optional branch or tag, runs the host's own git with the host user's credentials and no prompts, leaves nothing behind when it fails or runs past the caller's deadline, and answers an existing clone of the same URL instead of failing.
