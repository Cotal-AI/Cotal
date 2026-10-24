---
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

The CLI reference's command table links `channel` and `auth mint` at their real sections and adds
rows for `help`, `version`, `watch`, `team`, `endpoint`, `personas`, `manager`, `app-identity`,
`auth` and `service-endpoint`. `pnpm check:docs-site` now
fails on a link whose `#anchor` names no heading or
`<a id>` on its page.
