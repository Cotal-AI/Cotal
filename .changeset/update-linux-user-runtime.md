---
"cotal-ai": patch
---

On Linux, `cotal update` and `cotal update --self` can reach the systemd user manager without `XDG_RUNTIME_DIR` set. They use the same validated per-user runtime directory as `cotal daemon` and leave explicitly configured runtimes unchanged.
