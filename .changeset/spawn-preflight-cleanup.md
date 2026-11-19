---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/pi": patch
---

Refuse invalid spawn arguments and inaccessible working directories before provisioning credentials, reject pi resume flags, and remove Hermes launch credentials, sockets and disposable profiles after stopping.
