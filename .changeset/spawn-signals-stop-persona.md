---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
---

Stop child harnesses and retire provisioned credentials when foreground `cotal spawn` receives `SIGTERM` or `SIGHUP`, forward non-secret seat attribution into managed Codex and Jcode sessions so `cotal stop --self` works there, and report the specific field or YAML position when `cotal spawn` rejects an invalid persona file.
