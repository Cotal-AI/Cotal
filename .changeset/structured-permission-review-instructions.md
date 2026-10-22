---
"@cotal-ai/connector-core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Include the human-only approval, review link and unchanged-request retry instructions inside the structured pending result as well as its text. Native clients that show the model only structured content must still receive the instructions to wait for the person and never approve or poll on their behalf. Issuance remains blocked by the authority until the person's recorded decision.

Explain expiry without incorrectly claiming the person never approved: an approved request can also expire before its connection is issued. A fresh request still needs fresh approval.

Exercise native connection, exact recovery, capability attenuation and completed workflows through an isolated approval authority and fixture-person decision, including pre-approval transcript exclusion. Register the live approval controls in the smoke gate.
