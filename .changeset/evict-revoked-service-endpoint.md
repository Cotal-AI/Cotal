---
"@cotal-ai/auth": patch
---

Evict a revoked service endpoint's open serving connection through the delivery daemon until it is verified gone before confirming nonterminal cancellation, and bound the `eviction-unverified` hold by the 60 s serving credential lifetime plus clock tolerance from the revoked gate's broker timestamp when no delivery daemon answers.
