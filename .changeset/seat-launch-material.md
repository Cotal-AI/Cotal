---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
"cotal-ai": minor
---

Agent seats no longer export their connection material into the environment every descendant
process inherits. The broker URL, the creds path, the auth token, the user-mode identity and the
local control token now ride a private 0600 launch-material file whose path is the only thing in the
seat's environment; connectors whose session runs in the seat process drop even that path once they
have read it. A session driven by hand still sets `COTAL_CREDS` / `COTAL_SERVERS` itself, and a
launch that carries both carriers is refused rather than resolved by precedence.
