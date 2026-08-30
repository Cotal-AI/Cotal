---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
---

Refuse a `cotal_spawn` model pin the manager did not record, and name the recorded pin on the spawn result and orientation card so a dropped override cannot look like cross-vendor confirmation.

A Jcode variant-tier refusal now names the requested model pin rather than the session default RuntimeInfo still reports after setModel.
