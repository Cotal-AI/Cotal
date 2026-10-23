---
"@cotal-ai/cli": patch
---

`cotal history --dms` names a DM's recipient when a message in the window came from that principal, in the table and in `--follow` lines, and shows the principal otherwise. It used to show every recipient as a raw principal. An open-mode `chat` session's principal is now `local.<hex>`, the same form as other open-mode endpoints. It was `local.local_<hex>`, which read as a doubled prefix wherever the principal was shown. `result.items[].to` in `--json` is still the principal.
