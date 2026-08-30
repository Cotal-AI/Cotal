---
"@cotal-ai/connector-hermes": patch
"@cotal-ai/manager": patch
---

Inspect the `uv` executable used by the Hermes launcher during manager boot, and reject a PATH that only contains an unrelated `hermes` command.
