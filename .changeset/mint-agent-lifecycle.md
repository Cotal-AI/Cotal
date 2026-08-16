---
"@cotal-ai/cli": patch
---

`cotal mint --profile agent` now mints the lifecycle uid the agent profile requires, instead of failing on every invocation. The agent arm of `permissionsFor` builds lifecycle-keyed dm/dlv/chathist grants and threw without one, so the default profile could never be used and the only reachable profiles were observer and admin, neither of which can publish to a channel.
