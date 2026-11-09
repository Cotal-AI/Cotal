---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Refuse chat sends before publishing when a space's chat stream is absent, and report that absence in the connection state. Preserve unknown outcomes for lost publish acknowledgements and unconfirmed session retirement.
