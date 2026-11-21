---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
---

An agent's owner can now rename the agent, and every client in the space sees the new name while the agent keeps its identity. The `agent` endpoint advances to revision 4 with `set-name` `{ name }`, which only the owner's interactive session may call. The agent checks the name with the shared name rule, refuses the name of another live agent compared lowercased, changes its card's display name and republishes presence at once; refusals are typed with the `ai.cotal.agent.name-refused` detail (`name-invalid` or `name-taken`), and the current name again changes nothing. Messages sent afterwards carry the new `from.name`, and stored history keeps the old one. `CotalEndpoint.setCardName` makes the change, and an endpoint that watches presence reports a changed display name as a `presence` update and a `roster` event. A manager keeps a seat's last shown name apart from its alias and passes it as `COTAL_DISPLAY_NAME` (`LaunchOpts.displayName`) when it starts the seat again after a crash or a preserved resume, so the seat comes back under the same alias and actor with its last name. `ps`, resume commit and name allocation find a renamed seat by its principal, and in user mode a new spawn does not take a renamed agent's actor.
