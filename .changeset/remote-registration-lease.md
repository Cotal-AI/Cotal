---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

Remote Manager registration stays protected while its executor replaces an expired credential.

The host issues and renews a durable registration lease. Recovery must claim an expired lease before changing the frozen gate or credential family, and a claimed attempt cannot obtain new executor authority. Participants requiring this protocol refuse older hosts without lease support.

The manager reconcile command reports an active, invalid or mismatched host lease and exhausted confirmed claim conflicts as lifecycle refusals before repair effects, with a lease-specific next step. An unconfirmed lease write still reports an unknown outcome.
