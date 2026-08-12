---
"@cotal-ai/herdr": minor
"@cotal-ai/cli": minor
---

Add the Herdr integration: a new `@cotal-ai/herdr` extension with a self-registering `herdr` Runtime provider that spawns managed agents into panes of a dedicated named Herdr session (`cotal-<space>`), where the Herdr server owns them — they survive the manager's terminal going away and appear in Herdr's agent UI. Lifecycle is keyed by Herdr's stable `terminal_id` with the public pane id re-resolved per operation; creds ride an owner-only launcher script, never herdr's command line; every CLI call is scoped with `--session`. The CLI lists `herdr` among the official runtimes (`cotal runtimes`, `cotal ext add @cotal-ai/herdr`).
