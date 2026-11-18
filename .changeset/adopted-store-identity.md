---
"@cotal-ai/cli": patch
---

Adopting a renamed project folder no longer reports that its unchanged history store was replaced. Rebase the recorded store identity path with the journal while preserving the directory pins that detect replaced or missing stores.
