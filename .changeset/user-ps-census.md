---
"@cotal-ai/cli": minor
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/workspace": patch
---

User-mode `cotal ps` without `--on` now lists every one of the caller's registered managers in the space rather than requiring `--on` when more than one is live. It exchanges an `admin`-gated, read-only `registry-reader` view (`scatterFreezeReadRows(space)` plus its own reply inbox, human-only on both exchange faces; its stream-scoped `STREAM.MSG.GET` can read any row of `KV_cotal_records_<space>`, including goal, answer, and run rows, and `STREAM.INFO` with a subject filter lists every key — the residual the operator instrument carries, now also held for 5 minutes by an `admin`-scoped human on the public face), freezes the live `manager` endpoint registrations, keeps the instances whose registered spec `owner` is the caller's owner (or `local`, matching `managerGate`), asks each kept instance through a pinned `manager-caller` exchange, and renders the results with the shared single- vs. multi-manager layout and incomplete-census exit status.
