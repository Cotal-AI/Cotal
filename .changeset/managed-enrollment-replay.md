---
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

Retrying a managed launch after an enrollment or bearer preflight failure no longer loses the agent name.

Participant managers retain the unlaunched enrollment's token and request identity in their secret store and replay them for the same caller and persona authority. Each retry carries fresh observed-spawn authorization so an uncommitted attempt can recover after the earlier observation expires. Changed authority is refused with a recovery message instead of replacing the pending token.
