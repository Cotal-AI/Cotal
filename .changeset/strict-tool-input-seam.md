---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
---

The `cotal_*` tools now refuse an argument they do not model instead of silently
dropping it. A call carrying an unmodelled key — `owner` or `actor` alongside the
real arguments — previously succeeded with that key stripped before the tool ran,
so the caller was told nothing and the tool did something other than what was
asked. It is now refused by name, on every adapter: the MCP renderers and pi
publish a closed schema and the host rejects the call, while OpenCode and Hermes
pass the caller's object through untouched and are closed at the connector's own
dispatch. Behaviourally breaking for any caller that was relying on extra keys
being ignored; the refusal names the rejected keys and lists the accepted ones.
