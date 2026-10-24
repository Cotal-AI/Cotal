---
"@cotal-ai/cli": patch
---

A controller stack that took a channel-only `cotal team deploy` now starts again with a bare
`cotal up` after a clean `cotal down`, and the deployment's records and cards stay as they are. The
start used to refuse `LIFECYCLE_BLOCKED` with no next step, and `team remove` needed the registration
that `down` removed, so the stack could not start again. A start that another retained deployment
still blocks names `cotal team show <id>` for each one. `team remove` on a stopped stack names
`cotal up` in its root and then the remove again, and a refusal over an edited card names that card.
