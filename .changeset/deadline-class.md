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

A pause-plane deadline is recognized by the NATS client's TimeoutError class, so an error that only carries that name is no longer retried and then failed as a late reply.
