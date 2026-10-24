---
"@cotal-ai/cli": patch
---

`persona create`, `persona create --on` and `personas new` refuse `default_agent`, the name the
seeded default persona's agents launch under, instead of making a second persona that launches
under the same name.
