---
"@cotal-ai/connector-claude-code": patch
---

fix(connector-claude-code): forward `CLAUDE_CODE_OAUTH_TOKEN` to stop concurrent-spawn logout cascades

Every `claude`-connector spawn shared the operator's one Claude credential store (macOS Keychain /
`~/.claude/.credentials.json`), because the connector forwarded `HOME` but never a claude model
credential. Claude's subscription login is a single-use ROTATING OAuth refresh token, so several
concurrent `claude` agents raced on refresh: the first to rotate invalidated the token for the rest,
which dropped to `invalid_grant` / "Not logged in", cascading across every agent on the host
(issue #260).

The connector now forwards `CLAUDE_CODE_OAUTH_TOKEN` (the long-lived, non-rotating token from
`claude setup-token`) into each spawn, by name and only when the operator has it set. A single static
bearer shared across all agents sidesteps refresh-token rotation entirely, so concurrent agents no
longer log each other out. This is the credential the containerized deploy already used; it now works
for local spawns too. A single-agent subscription login is unaffected (the token is absent, so nothing
changes). `docs/connect-claude.md` documents the one-time `claude setup-token` step.

Note: per-agent `CLAUDE_CONFIG_DIR` isolation was deliberately not taken — on macOS the OAuth token
lives in a fixed shared Keychain item not scoped by that directory, so it would not fix the race on
the platform the bug was reported on.
