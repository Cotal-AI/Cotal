---
"cotal-ai": patch
---

A default `cotal daemon install` now refuses before registration when the shell home and the account home the background service will use differ. The refusal names both directories. Unset the override, or pass `--daemon-home`.
