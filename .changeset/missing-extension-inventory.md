---
"@cotal-ai/cli": patch
---

Self-update no longer reports a current package closure when a seeded extensions prefix is missing its inventory, including when only its package lock remains. `cotal version`, `cotal update --check`, and `cotal ext list` report that inventory as unreadable and direct repair to `cotal ext seed --repair`. A command that still reconciles, including `cotal up` and `cotal backup restore`, names `cotal ext seed --repair` and does not rebuild the inventory. Self-update and `cotal ext seed --repair` rebuild it. A failed rebuild leaves the inventory missing for the next update.
