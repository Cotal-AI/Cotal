---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
---

The `cotal_*` tools now refuse an argument they do not model instead of silently
dropping it. A call carrying an unmodelled key (`owner` or `actor` alongside the
real arguments) previously succeeded with that key stripped before the tool ran,
so the caller was told nothing and the tool did something other than what was
asked. It is now refused by name, on every adapter and on every tool: the MCP
renderers and pi publish a closed schema and the host rejects the call, while
OpenCode and Hermes pass the caller's object through untouched and are closed at
the connector's own dispatch. Tools that take no arguments are closed too: they
were previously published with no schema at all, so a host had nothing to check
against and forwarded the extras to be dropped, as is `cotal_inbox`, whose
arguments four of the connectors replace with their own. Behaviourally breaking
for any caller that was relying on extra keys being ignored. Every refusal names
the rejected keys; where the connector is the one refusing it also lists the
arguments the tool accepts, or says it takes none.
