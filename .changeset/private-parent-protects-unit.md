---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Fix Linux daemon installation when an owned group-writable systemd unit directory sits below a private directory that other accounts cannot traverse.
