---
---

The docs site publishes the Upgrading page, so the relative link to it from Identity and auth no longer stops the site build. `pnpm check:docs-site` runs the site's docs sync, and `pnpm check:docsbundle` now includes it, so a relative link to a page the site does not publish fails locally and in CI instead of first failing the Docs deploy. This changes the docs site and repository tooling only; no published package changes.
