---
"cotal-ai": patch
---

Refuse an unmintable spawn name client-side before the manager round trip: `cotal spawn` now applies the core name door (the same predicate the manager applies) to the effective identity on both the foreground and `--detach` paths, keyed on the target mesh's auth mode, so a hyphenated name on a user-auth mesh fails immediately with the actor-token explanation and the `_` remedy instead of after the provisioning call.
