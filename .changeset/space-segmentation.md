---
"@cotal-ai/core": patch
"@cotal-ai/workspace": minor
"@cotal-ai/delivery": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Key per-tenant material per space instead of per root. The five root-scoped kinds (the `$SYS` cred pair, `membership.json`, `membership-rw.creds`, `delivery.creds`) and every per-agent standing secret now live under `space.<hex>/` segments, migrated on first touch through one choke point that refuses — loudly, with an honest remedy — on any root it cannot show to hold a single tenant. `space rm`'s step-7 reaps land with their step-1 preconditions ahead of the verb itself. Also: the delivery daemon's `$SYS` repair advice now asks the guard instead of printing commands that refuse on the roots that need them, expired user bearers stop being re-presented on reconnect (with the retry bounded), and `agentSecretKeyForFile` takes the caller's space and checks the recorded path against it, so a stored path can no longer address another tenant's material.
