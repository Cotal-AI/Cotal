---
"@cotal-ai/connector-core": patch
---

Include the human-only approval, review link and unchanged-request retry instructions inside the structured pending result as well as its text. Native clients that show the model only structured content must still receive the instructions to wait for the person and never approve or poll on their behalf. Issuance remains blocked by the authority until the person's recorded decision.
