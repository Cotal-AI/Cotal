---
"cotal-ai": patch
---

Explain the systemd requirement when installing the Linux daemon service on an unsupported host.
Daemon install and setup refuse before resolving the runtime directory when systemd or systemctl
is unavailable. Automatic-update advice names foreground supervision and manual updates instead,
and missing runtime directory guidance explains how to provide a private directory.
