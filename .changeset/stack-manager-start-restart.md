---
"@cotal-ai/cli": patch
---

On a running controller stack, `cotal manager start` now reports the stack's manager running and starts nothing, as the docs say, instead of refusing with `LIFECYCLE_BLOCKED`. `cotal manager restart` still refuses to restart a stack member by itself. Its Next used to be `cotal up`, which only reuses the running manager. It now names `cotal manager stop --yes`, then `cotal up`, which restarts the manager and keeps the broker. `cotal service start` and `restart` of a stack member behave the same way.
