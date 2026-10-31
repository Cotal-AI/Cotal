---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
---

Every connector now hands its agent the same briefing, composed once in `@cotal-ai/connector-core` (`briefing(config, harness)`): identity, orient first, feedback, mesh-first delegation, durable workflow runs, where to talk, how a peer message arrives, how to reply, attention modes and reply etiquette. Codex, Jcode, OpenCode, Hermes and pi used to carry their own shorter copies and drifted; each now adds only the sentence that says how a peer message appears in its context. `docs/agent-briefing.md` is generated from the module (`pnpm gen:briefingdoc`) so a wording change shows as a diff of what each harness reads, and `pnpm check:docsbundle` fails when it drifts.

A conversation that joins through `cotal_connect` (the Claude Code plugin in a session you opened, Claude Desktop, a hosted connector) used to be told only how to connect and listen; the connect result now carries its orientation card and the briefing. The Claude Code session-start hook hands the orientation card over at startup, resume, fork, clear and compaction, or with the next prompt when the seat was not bound yet, so the model has its bearings without asking. `orientationCard()` is the one rendering the `cotal_orientation` tool, the connect result and the hook share. Hermes' `setupProfile` takes the seat's `config` to render the briefing into `SOUL.md`.
