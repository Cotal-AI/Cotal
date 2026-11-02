---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

A space catalog entry can now say a space is temporarily unavailable, with `"unavailable": "<reason>"` in place of its registration. The CLI keeps the registration it already holds for that space, and commands for the other spaces in the catalog keep working. A command that targets the unavailable space refuses with `DEPENDENCY_UNAVAILABLE` and the catalog's reason, and `cotal sync` lists it under `unavailable`. Before this, a catalog had to fail as a whole, which stopped commands for every space in it.
