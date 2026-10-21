---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

Bare `cotal ext` (and `ext list`) writes one structured document with `--json` and a plain report with `--plain`: `result.root` is the install prefix and `result.items` the installed extensions. This replaces one JSON line per extension. `--json` and `--plain` on the other `ext` subcommands are refused with `USAGE_INVALID`, and `ext root` stays a raw path.

A subcommand can declare its own structured outputs (`Subcommand.outputs` in `@cotal-ai/core`). The kernel reports a form by the 0 to 5 exit table only when that form declares a JSON output, and help prints each form's own `structured output` line, so `ext add`, `ext remove` and `ext seed` keep exiting 1 on any failure.

Add `cotal docs [<page>]`, the installed version's own protocol and CLI docs, offline: bare `docs` lists the pages, a page prints its Markdown, `--search <query>` shows the best-matching sections, and `--refresh` also tries the version-pinned copy on docs.cotal.ai and says which copy it served. `@cotal-ai/connector-core` exports the docs reads it uses (`docsIndex`, `readDocsPage`, `searchDocs`, `capSection`) through a new `./docs` subpath, so the bundle loads only when `docs` runs.
