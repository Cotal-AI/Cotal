---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

Add closed trusted observer request filters and migrate the auth service's existing subscriptions without widening valid subject scope. Refuse noncanonical raw account spaces and filters over 1024 bytes before activation effects, including prior-active replays. Preserve normalization at the two existing normalizing adapters. Correct the test-only census to distinguish decoded syntax literals from comments.
