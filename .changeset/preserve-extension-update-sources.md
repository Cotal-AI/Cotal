---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Keep local, tarball, Git, and URL `@cotal-ai/*` extensions on their recorded source instead of fetching `<pkg>@<cli-version>` from npm during `cotal update`, `cotal update --self`, seed reconciliation, and offline extension repair, and validate non-release `@cotal-ai/*` `@cotal-ai/core` peer ranges when loading them in the CLI or Manager. An install on `0.159.1` through `0.183.1` that holds a local `@cotal-ai/*` package the registry does not publish is still refused by that old release's own preflight on `cotal update --self`: upgrade once with `npm i -g cotal-ai@<new>` followed by `cotal update` so the local path already recorded in `extensions.json` is preserved for future self-updates.
