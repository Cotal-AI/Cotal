---
"@cotal-ai/cli": patch
---

`up`, `up --restore` and `backup restore` refuse a `--store-dir` that is a control directory or lies
in one, such as a root's `.cotal` or the machine home's `.cotal/nats`, unless it is the root's own
`.cotal/nats`. Before, the broker wrote its store among the root's credentials and records, or into
the home stack's store, and `reset store` then could not inspect it or offered to remove the home
store.
