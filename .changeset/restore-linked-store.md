---
"@cotal-ai/cli": patch
---

A default `backup restore` or `up --restore` on a root whose `.cotal/nats` links to its store now
restores that store in place. It ended `OPERATION_UNKNOWN` (exit 3) with "alternate restore target
must not equal … the retained source", though no `--store-dir` was given and nothing had changed.
