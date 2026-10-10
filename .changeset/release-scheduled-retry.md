---
"cotal-ai": patch
---

Retry the GitHub Release on a schedule. The registry has started serving a published package after the closure gate's deadline, and that publishing run skipped the Release with nothing to retry it but the next push to `main` or a manual rerun. The closure gate, the install gate and the Release now run in their own `release` job, after `version` on a push and on their own once an hour, and a run whose version already has its Release stops before either gate.
