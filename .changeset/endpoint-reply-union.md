---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/lang": minor
"@cotal-ai/seat": minor
"@cotal-ai/runtime": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
"@cotal-ai/web": minor
"@cotal-ai/linear": minor
"@cotal-ai/cmux": minor
"@cotal-ai/orca": minor
"@cotal-ai/tmux": minor
"@cotal-ai/herdr": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/pi": minor
"@cotal-ai/auth": minor
"@cotal-ai/registry": minor
---

A failed endpoint reply must carry its error, and a successful reply cannot carry one.

`EndpointReply` is now a union on `ok`. The parser already refused a success that carried an error and a failure that omitted its error or carried data, and callers that checked `ok` can read the matching field directly.
