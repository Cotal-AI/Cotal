---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

Reconcile installed extensions automatically after a manual `npm install -g` upgrade. When automatic updates are on, the background service's scheduled check finishes any pending extension reconciliation even when the CLI is already at the latest release, and the CLI launch gate brings operator-installed official extensions current alongside the built-in connectors or refuses with `cotal update --self` if it cannot.
