---
"cotal-ai": patch
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/lang": patch
"@cotal-ai/seat": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/delivery": patch
"@cotal-ai/web": patch
"@cotal-ai/linear": patch
"@cotal-ai/cmux": patch
"@cotal-ai/orca": patch
"@cotal-ai/tmux": patch
"@cotal-ai/herdr": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-hermes": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/pi": patch
"@cotal-ai/auth": patch
"@cotal-ai/registry": patch
---

The service list shows the recorded state of a start that failed, instead of calling a live process running and an exited one stopped.

A readiness check that keeps answering another status records unknown and leaves the process running. A process that exits before readiness records failed. `cotal service` now prints that recorded state, the same one `cotal service status` prints, and its Next is status while the record is running, starting, stopping or unknown.
