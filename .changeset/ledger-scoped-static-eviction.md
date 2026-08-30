---
"@cotal-ai/manager": patch
---

Scope the static terminal's verified broker eviction to the credential ledger's holder principals. A lifecycle that never minted a credential retires without demanding an oracle for a principal that was never issued, while a non-empty holder set still fail-closes until every named principal is verified gone.
