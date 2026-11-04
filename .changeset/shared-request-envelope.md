---
"@cotal-ai/core": patch
---

Manager requests and delegated user intents now share their base-envelope validation. Accepted fields, token grammar, refusal messages and validation order are unchanged, including requests with more than one invalid field.
