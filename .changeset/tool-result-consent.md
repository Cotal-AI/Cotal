---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

Tool-result sharing now needs a human consent. Core adds the `consents` anchor role and `mintToolResultConsent`/`verifyToolResultConsent`: a signed artifact binding the space, the exact target incarnation, a holder under the target's owner, a fresh human proof and a window of at most 24 hours. The connector journal captures nothing until a verified consent is applied through the handle-only `tool-result-consent` command, answers `not-shared` to readers no consent names, and discards everything when the last consent is revoked (`tool-result-revoke`) or expires. The Claude Code connector routes its mapped transcript through the journal; serving still needs an issued serve grant.
