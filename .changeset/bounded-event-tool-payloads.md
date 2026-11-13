---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/web": minor
---

Publish bounded tool inputs and results to permitted event readers and show them in interactive console details and dashboard Work turns.

Payloads use a separate owner-scoped rail. Owners and space admins can read them by default, while another owner needs an explicit concrete event-channel grant. Cotal tool payloads are excluded. Use `--no-event-payloads` or a persona's `eventPayloads: false` to retain names and times without publishing inputs or results. The credential grant enforces withholding.

Full backups retain payload frames and their owner-scoped subjects. Registry-only restores leave payloads empty. New backups use format v3, and restore continues to accept the exact v1 and v2 inventories. A space without the payload stream keeps publishing tool names and times and reports that payloads are unavailable until its broker setup is upgraded.
