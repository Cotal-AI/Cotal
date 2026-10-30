---
"@cotal-ai/cli": patch
---

Give an unreadable persona catalog a next step. `persona` and the legacy `personas list` suggest
`chmod u+rx <folder>` only for a catalog folder you own whose mode denies you read or search. A
folder above the catalog that you cannot enter is named instead, and a folder another account owns
says to ask its owner. Any other read error keeps the refusal with no next step, and nothing changes
a mode. The legacy `personas list` now names the space in that refusal, as `persona` does. Exit codes
and the `PERMISSION_DENIED` code are unchanged.
