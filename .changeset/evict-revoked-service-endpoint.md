---
"@cotal-ai/auth": patch
---

Revoking a bound service endpoint now evicts its open serving connection through the space's delivery daemon and waits until the connection is verified gone (up to 20 s per call) before confirming `cancelled-nonterminal`, instead of letting an open connection keep answering calls until its 60 s credential expires. When eviction cannot be verified yet for any reason, `revoke` lands deny-new and answers `held` (`eviction-unverified` at phase `V5-evict`) for at most `ceil(T) + 71` s from the revoked gate's broker timestamp (the 60 s serving credential lifetime plus `2 * 5` s clock tolerance and 1 s whole-second rounding), after which a replay confirms `cancelled-nonterminal`.
