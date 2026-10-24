---
"@cotal-ai/cli": patch
---

An unpinned `spawn -d` whose describe no manager answers, as when every registered manager's process has died, is now refused `TARGET_UNAVAILABLE` (exit 2) saying the launch was not sent and nothing was launched. It used to report `OPERATION_UNKNOWN` (exit 3) and tell you to inspect the manager before retrying, although nothing had been submitted. When this folder's stack records its manager stopped, starting or running but silent, the refusal says which and names the same next step `ps` does.
