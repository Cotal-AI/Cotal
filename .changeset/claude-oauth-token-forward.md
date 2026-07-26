---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
---

fix(connector-claude-code): forward `CLAUDE_CODE_OAUTH_TOKEN` so concurrent claude agents stop racing on one login (#260)

Every `claude`-connector spawn inherited the operator's `HOME` and set no per-agent auth, so all
claude agents on a host shared one Claude login. That login's subscription-OAuth refresh token is
single-use and rotates, so a handful of concurrent agents refreshing at once knock each other out
with `invalid_grant` ("Not logged in") in a cascade. Per-agent `CLAUDE_CONFIG_DIR` does not fix this
on macOS — the token lives in a fixed shared Keychain item that `CLAUDE_CONFIG_DIR` does not scope.

The connector now forwards `CLAUDE_CODE_OAUTH_TOKEN` (by name, only when present) on the same
`launchEnv` provider-key rail opencode/hermes already use. An operator who runs `claude setup-token`
once and exports the resulting long-lived, non-rotating token has every spawn authenticate off that
single static bearer — nothing to rotate, nothing to race. Absent, behavior is unchanged. Precedence,
trust posture (the token is the account bearer and reaches each agent's env), and the restart-to-rotate
caveat are documented in `docs/connect-claude.md`; a new CI-wired smoke (`smoke:claude-auth-env`) asserts
the token is forwarded when set, absent when unset, never on argv, and that unrelated operator secrets
do not bleed. connector-core carries the updated provider-key doc comment and the regenerated docs
bundle.
