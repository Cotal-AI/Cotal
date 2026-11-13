---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Finish manual updates after stopping agents with explicit consent, and show when installation reconciliation is pending.

Terminal updates list affected agents and ask once before stopping them. Scripts can use `cotal update --self --stop-agents`. Automatic updates continue to defer without stopping agents.
