---
"@cotal-ai/core": patch
---

Allow trusted workflow hosts to bind the run-stable caller and mediator grants to an authenticated owner. Preserve existing static/local callers and keep driver grants confined to their run. This prepares the owner-binding primitive; user-auth workflow execution remains unavailable until admission and remote mediation are integrated.
