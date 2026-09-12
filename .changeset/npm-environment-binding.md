---
---

Bind npm trusted publishing to a deployment-protected GitHub Environment (`npm-publish`).
Both the `version` and `snapshot` publishing jobs now reference this Environment, and the
OIDC identity assertion rejects tokens that do not carry the matching environment claim.
