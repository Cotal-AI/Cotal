---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

On Linux, `cotal update` and `cotal update --self` can reach the systemd user manager without `XDG_RUNTIME_DIR` set. They validate the inferred runtime at each native call and leave explicitly configured runtimes unchanged. An unsafe inferred runtime refuses with a reason and a next step.
