---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Retire timed bare `join` sessions cleanly at expiry, refuse unsupported `--creds` profiles and control invocations up front with clear next steps, validate `auth mint` channel patterns before creating output folders, preserve `--provision` in `doctor auth` export repair commands, and keep static-auth roots and `doctor auth` consistent with `--open`.
