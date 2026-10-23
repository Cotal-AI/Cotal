---
"@cotal-ai/workspace": patch
---

A paired endpoint caller file from `cotal auth mint <name> --endpoint <class> --out <file>` now works with `ep describe`, `ep invoke` and `invoke` under `--creds <file>`. The mint recorded the endpoint's wire token in `<file>.issuance.json`, and reading that intent back refused the token, so every such call failed with "the endpoint contract read did not complete" before any request was sent. The intent now keeps the dotted endpoint name. An intent written by an earlier release is refused with `SCHEMA_INVALID` and a remedy to issue a new caller.
