---
"@cotal-ai/cli": patch
---

When the space's service instance records folder under `services/` in the Cotal home was not writable, `cotal down --yes` exited 3 with an unknown outcome, left every member running and blamed the manager, and `cotal up` exited 3 saying the stack did not start every member. Neither named the folder. Both now refuse `PERMISSION_DENIED`, exit 2, before anything starts or stops, naming the folder and the `chmod u+w` that fixes it, and `down --dry-run` names it as a refusal the real stop would hit.
