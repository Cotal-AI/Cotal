---
"@cotal-ai/manager": patch
---

A name held pending retirement keeps the departed seat's whole teardown target, and a same-name spawn or a resume re-drives that target unchanged. Before, both re-drives rebuilt it field by field and dropped the seat's recorded runtime reference, so under tmux a same-name spawn re-drove a static retirement that skipped the reap and freed the name while the predecessor seat still ran. The resume re-drive also dropped the launch's subscribe channels, which name the membership rows its teardown deletes.
