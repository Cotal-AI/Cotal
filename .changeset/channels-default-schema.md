---
"@cotal-ai/cli": patch
---

A default `.cotal/channels.json` that is not JSON makes `cotal up` refuse `SCHEMA_INVALID`, as the docs say and as invalid content in it does, with the classified report and the same remedy. It used to refuse `USAGE_INVALID` and print the whole `up` help.
