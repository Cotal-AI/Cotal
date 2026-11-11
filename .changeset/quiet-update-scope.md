---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Keep authenticated automatic updater processes outside the Linux daemon service during replacement.

The reconcile child moves itself and its waiting parent into a systemd user scope before reconciliation. This requires cgroup v2, systemctl, busctl, and user-manager permission to adopt existing PIDs. Migration denial fails visibly after package replacement, leaving existing parent retry and restoration behavior unchanged. Restart and startup verification behavior are unchanged.

The custody inspector accepts group-writable owned paths when bounded local account records prove the caller's primary group has no other member or account. Unknown account sources fail closed. This inspector does not examine extended ACLs.
