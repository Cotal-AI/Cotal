---
"@cotal-ai/cli": patch
---

A first `cotal up` no longer prints `✓ restored in the background: manager (pid N)`. The line came from the control-plane helper that every launch shares, so the detached, foreground and resume launches claimed a restore whenever they started their manager. Only a refresh of a running mesh prints it now, when it starts a manager that was missing.
