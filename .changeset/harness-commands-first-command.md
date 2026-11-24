---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
---

A launcher can now list the commands and skills a harness offers in a directory before any agent starts, and start an agent with one of them as its first turn. The Manager's new `harness-commands` read (`{ agent, cwd }`) asks Claude Code, Codex, pi or OpenCode 2.x in that directory and answers the entries a seat's `command` takes, or `supported: false` with a reason for a harness whose seats run no commands; it starts no seat and is granted where `list-dir` is. `spawn` takes `firstCommand: { target, name, args? }` and its acceptance names `firstCommand.id`. The agent queues the command under that id before any other and runs it as its first turn through its own command lane once the harness runs commands, and `command-state` reports a refusal. The Manager cluster advances to revision 54.
