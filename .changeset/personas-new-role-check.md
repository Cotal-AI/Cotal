---
"@cotal-ai/cli": patch
---

`cotal personas new` now refuses a `--role` that is not a single NATS-safe token (`[A-Za-z0-9_-]`), as `cotal persona create` does, instead of saving it and suggesting a `cotal spawn` that refuses it. Nothing is written on the refusal, so `--force` no longer replaces a working persona with one that cannot launch.
