---
"@cotal-ai/cli": patch
---

`cotal persona create` now checks each `--subscribe`, `--allow-subscribe` and `--allow-publish` entry against the channel rules and refuses a bad one with `USAGE_INVALID`, naming the flag and the entry. A name written with `#`, such as `--subscribe '#general'`, gets a remedy to drop the `#`, and a `--subscribe` channel outside `--allow-subscribe` is refused the same way. It used to refuse with `SCHEMA_INVALID` about a temporary draft file you never saw.
