---
"@cotal-ai/cli": patch
---

`cotal up --detach` now wraps its `Started nats-server` line, its `✓ running in the background` line and a repair's `reopening the recorded store` line at spaces on a terminal, as other lines do. A path wider than the line keeps a line of its own and is never split, the summary's continuation lines start under its text, and `cotal down` stays whole. Off a terminal each is still one line on stdout, and exit codes are unchanged.
