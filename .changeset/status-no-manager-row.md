---
"@cotal-ai/cli": patch
---

`cotal status` on a controller stack started with `--no-manager` now has a Manager row saying the stack runs no manager by choice and that bare `cotal up` adds it. It used to list the broker and delivery members and never mention the manager. `status --json` reports it as `folder.noManager`.
