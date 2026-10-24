---
"@cotal-ai/cli": patch
---

`cotal down` on a controller stack whose JetStream store holds more than its cap now refuses `DEPENDENCY_UNAVAILABLE` (exit 2) before any stop, naming the store and the cap. The manager's stop needs a credential whose issuance record the broker stores first, and the full store refuses it. It used to exit 3 with only "insufficient resources" and leave every member running. Its Next is `cotal history clear --yes`, then `cotal down`. `down --dry-run` reads how much the space holds when the manager runs and names the same refusal as a warning.
