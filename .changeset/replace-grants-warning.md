---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

An agent-profile `auth mint <label> --replace` now warns `REPLACED_GRANTS_CHANGED` when an old agent
credential names this space's account as issuer and declares different grants. The warning names
both sets and the `--allow-subscribe`, `--allow-publish` and `--role` flags for the replaced ones.
Grant selection, inheritance, profiles, expiry and revocation are unchanged.
