---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/acp": minor
"@cotal-ai/web": minor
---

T3 Code and other ACP clients now get from every Cotal agent what that harness's own provider shows: replies streamed as they are written, tool calls with their arguments, results and diffs, plans, approvals, questions, the agent's own commands, cancel, later prompts with images, context usage, reasoning, and the model and effort pickers.

- Core: the `agent` endpoint is at revision 5, with `turn` (the owner's next prompt, with images) and `usage` (context and cost). Presence gains `agentEndpoint: { interrupt, turn, images, usage }`, which says what a process serves now, so a caller picks one path per agent before it sends anything. `ModelCatalogOpts.envAllow` gives a model catalog read the `spawn.env` names a launch receives.
- Manager: cluster revision 54. `spawn` takes the opt-in `askPermissions` (ask before tool use) and `reasoningEvents` (publish the model's reasoning), and every `status.connectors` row says whether its connector takes them. Update Managers and their callers together. `@cotal-ai/workspace` carries the two fields in a managed launch and in the cached connector rows.
- connector-core: a delta journal beside each thread's journal streams harness text and reasoning before the harness saves it, merged into the durable source, and a connector may journal records of its own there. `JsonlFileSource.holdsSync` tells whether a cursor is on the file at the path now. A tool result marker may leave out `isError`, and `web` reads one without it.
- Claude Code: a tool call shows within about a second of its start while the tool runs; reply text streams while the command mod runs; the owner's turns take images as files the model reads; usage, effort levels as model variants, both launch fields, and `AskUserQuestion` as a question form. Reply text that Claude Code does not show, such as "No response requested.", is not published. The release plugin tree now ships `hooks/stream.js`. The to-do tools stay off as Claude Code's terminal has them for current models; an operator turns them on with `CLAUDE_CODE_ENABLE_TODO_TOOLS` through `spawn.env`.
- Codex: replies and reasoning summaries stream; turns with images and usage; approval requests, questions, permissions requests and MCP elicitations go to the prompt desk; `askPermissions` launches in the approval-required mode; a code-mode script's calls and plan show as their own tool calls while they run. Codex now publishes reasoning only for a launch with `reasoningEvents`, where before it published every summary it recorded.
- Hermes: turns, interrupt, usage and the gateway's slash commands on the agent endpoint; streamed replies; reasoning with `reasoningEvents`; `askPermissions` for the commands Hermes stops; `clarify` questions on the prompt desk; the models of the provider a launch's environment selects, with Hermes's reasoning efforts as variants; tools run in the seat's folder; and a run shared by several messages ends with the outcome of the message that ends it.
- Jcode: native session commands, interrupt, turns with images, usage and streamed text and reasoning; a failed turn closes its run with the error; the seat's real home, so the shell tool runs on Jcode 1.1; and streaming keeps going across a journal fold that reuses the file's inode.
- OpenCode: agent commands and interrupt on 1.x; turns with images and usage, permission asks and questions on the agent endpoint, both launch fields, streamed replies and running tool calls on 2.x and 1.x. On 1.x, usage reads the newest step, and a command whose turn never starts frees the seat after 5 seconds.
- Pi: tool arguments and results on the payload rail, turns and usage, thinking levels as variants, `askPermissions`, streamed replies, thinking with `reasoningEvents`, and the model catalog read with the launch's `spawn.env` names.
- `cotal acp`: picks each agent's cancel, prompt, image and usage path from its presence; sends a turn's usage before the prompt answers; gives each model's reasoning choices in the session's model state, so T3 shows the effort picker before a thread runs; launches with the two fields where the connector takes them; shows tool details, plans, Codex's change approvals as diffs, and the agent's own commands; asks an agent's approvals and questions, also ones it opens between the thread's turns, and asks a prompt again when its first read fails; keeps a prompt queued behind the agent's other work open until the agent runs it, and a cancel takes it out of the queue; never defaults a thread to another computer's manager; lists an application's default model once when its catalog also has a model named `default`; refuses an application whose models the manager could not read, with the manager's reason, in place of offering its default alone; offers a short persona and channel select plus `/persona` and `/join` where the lists are too long for a select; and says what it cannot replay when an agent's tool details cannot be read.
- `cli`: the Hermes model remedy no longer suggests `--no-events`.
