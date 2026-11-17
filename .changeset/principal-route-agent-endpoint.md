---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

An agent can now serve commands about itself, such as its pending harness prompts, to its owner's sessions over the control surface, with no registration and no Manager.

Core adds the principal route (SPEC §13.21): requests on `cotal.<space>.ep.prin.<endpoint>.<owner>.<actor>.<lifecycleUid>.<runtimeId>.<command>.<authority>.<caller>.<nonce>`, replies on `ep.prin-reply`, and a no-responders sentinel no serving credential can publish on. A process serves it with `CotalEndpoint.servePrincipal`, whose `ready` resolves only after the broker accepted the subscription and which binds again after every reconnect, and calls it with `CotalEndpoint.callPrincipal`. Both routes now run one shared request pipeline. A cluster command declares the authority words it admits in `authorities` (`owner` or `grant`); a service route refuses such a command. Revision 1 of the `agent` endpoint (`ai.cotal.agent`) defines `prompts`, `prompt` and `prompt-answer` with closed schemas for a prompt, its form profile and its states (SPEC §13.22), and presence gains `prompts: { open, seq }`. The auth callout now mints serve rows into every agent credential of a ledger row, and `owner` caller rows into those of an interactive row, from the row's kind. An agent needs a connection minted by an auth service on this release before it can serve. SPEC §13.2 also now counts seven authorization-mode tokens, not six.
