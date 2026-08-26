---
"@cotal-ai/connector-core": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/pi": minor
---

A spawned seat now receives a constructed environment (PATH/HOME/locale, the machine-wide COTAL_* knobs, connector-declared provider keys) instead of the manager's ambient environment. Host-session markers such as CLAUDE_CODE_CHILD_SESSION no longer leak into seats and silently disable transcript saving. spawn.env remains the explicit opt-in for extra names, including a host marker a persona has chosen to receive.
