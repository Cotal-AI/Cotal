---
"@cotal-ai/connector-claude-code": patch
---

Generate the Claude Code marketplace manifest with object plugin entries

`cotal setup` wrote `.claude-plugin/marketplace.json` with `plugins` as bare names. Claude Code
validates that form, so `plugin marketplace add` and `plugin marketplace update` both report
success, and the install then fails with `Plugin "cotal" not found in marketplace "cotal-mesh"`.
The message points at a stale local copy rather than at the manifest, so the suggested
`marketplace update` changes nothing, and re-running setup regenerates the same file over a hand
repair. Setup pauses at that step, so later steps including persona seeding never run.

Each present plugin is now listed as an object carrying `name`, `source` and the `description`
read from that plugin's own `plugin.json`.
