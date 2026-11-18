---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-opencode": minor
---

An agent owner's interactive session can now list an OpenCode 2.x agent's own commands and skills and run one, such as `/review`, and every other caller is refused by the broker.

`@cotal-ai/core` advances the `agent` endpoint's cluster to revision 2 with `commands`, which lists `{ name, target, description?, inputHint? }` entries or answers `{ supported: false }`, and `command`, which runs one by `{ target, name, args? }` and answers `{}` once the harness accepted it. Both declare the `owner` authority word only, so an interactive ledger row gets their caller rows, and no grant row can name them. Every refusal carries a fixed code and outcome: a command that never started is `not-executed`, and one whose start is not known is `unknown`. `@cotal-ai/connector-core` adds `openAgentEndpoint`, the one owner of the agent serve, which replaces `openPromptDesk` and serves the prompt desk beside a command lane. Every `MeshAgent` with a user-auth credential opens it, with the connector's `commands` dispatcher or none. A command starts only while no turn runs, at most 8 wait, and a reply waits at most 10 s. A connector takes each waiting command with `dispatchNextCommand()` when `MeshAgent` emits `command`. An open or static mesh serves nothing yet. `@cotal-ai/connector-opencode` lists `GET /api/command` by name and `GET /api/skill` by id and runs a command through `/command` and a skill through `/prompt`. A first-turn command carries the persona's `system` field as a first message does, though OpenCode 2.2.5 passes it to the model for neither, and right after a command turn, waiting messages go first.
