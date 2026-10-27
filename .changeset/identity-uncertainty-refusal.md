---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`identityUncertaintyRefusal` takes only a torn pin, a torn pairing, or an unpinned live pid. A match, a gone pid, a legacy record, a mismatch, and a pidfile with no pid are no longer arguments of it, and a kind outside those three throws instead of returning a refusal that calls the state unsupported. `cotal` stop still refuses a torn or unpinned record with the same operator text and still handles the other states itself.
