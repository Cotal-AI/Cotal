---
"@cotal-ai/auth": patch
---

`auth grant` and `actor grant` refuse a `--scope` name the ledger is never checked for, such as a
typo of `spawn`, with `USAGE_INVALID` naming each unknown name and the capabilities there are:
`admin`, `run`, `spawn`, `supervise` and `role:<role>`. Such a grant used to be stored as written.
An input that is not valid now names its field and why, every one in one refusal, where it used to
say only "invalid actor, owner, parent, role, scope or channel-pattern input".
