---
"@cotal-ai/cli": patch
---

`cotal doctor auth` now names `--profile observer` or `--profile admin` in the `auth mint --replace` it gives for an expired, unbounded or revoked standing credential of that profile, and no longer opens that guidance with a manager that runs an agent. Following the old guidance turned an observer into an agent credential that could read nothing. `auth mint --replace` also warns `REPLACED_PROFILE_CHANGED` when the replacement has another profile than the credential it replaced, and `NOTHING_REPLACED` when the label had no standing credential, stating that exported files stay unchanged and naming `doctor auth` for their state-specific guidance.
