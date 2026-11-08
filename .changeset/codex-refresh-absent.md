---
"@cotal-ai/connector-codex": patch
---

Keep Cotal upgrades working on computers without the Codex plugin installed.

Refresh checks Codex's native plugin cache before invoking its executable. Cached installations still require a working Codex command, and unreadable caches refuse the upgrade rather than being treated as absent.
