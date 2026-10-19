---
"@cotal-ai/connector-core": patch
---

Six docs table rows had more cells than their header, so GitHub and the docs site dropped the end of each row: the transport page's Routing row, and in the SPEC the `lifecycle` head row, the lifecycle mapping and teardown row, the two auth rows added for #399 (the registered auth instance and the retirement requester call), and the 2026-07-15 changelog row. A `|` inside a code span still starts a new cell in GFM, so those pipes are now written `\|`, and the two #399 rows carry their grants in the namespace cell instead of a fifth column. The docs site sync now fails on a table row with more cells than its header and names the page and row, so `pnpm check:docs-site` catches the next one. The `cotal_docs` pages carry the corrected rows. No runtime change.
