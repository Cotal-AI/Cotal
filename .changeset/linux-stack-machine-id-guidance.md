---
"@cotal-ai/cli": patch
---

When a prepared Linux stack cannot start because its machine ID is missing, Cotal names `/etc/machine-id` and shows how to provision it without systemd. The stack still requires a stable machine ID and a readable kernel boot ID to establish process ownership.
