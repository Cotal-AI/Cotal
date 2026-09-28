---
"@cotal-ai/connector-opencode": minor
---

OpenCode support adds a new supported host line, `@opencode/cli` 2.x, alongside the existing 1.x line. A single directory plugin target now bundles both lines from one entry file. On 2.x the connector adds a 2.x viewer and the model, session, turn, prompt and model.request routes over the plugin's own event stream, since 2.x carries no AG-UI event plane. An unsupported OpenCode version is refused loud at spawn instead of silently degrading. Two 2.x limits: the event plane needs `--no-events`, and `cotal models` is refused because the 2.x catalog is served by a running opencode server rather than the CLI.
