---
"@cotal-ai/cli": patch
---

`cotal persona create --harness <name>` refuses a harness this machine does not know, with `USAGE_INVALID` and the list of known harnesses, the same check `cotal config set harness` makes. It used to save the pin as given, so a typo surfaced only when the persona was spawned.
