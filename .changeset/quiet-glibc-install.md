---
"cotal-ai": patch
---

Refuse npm installation on unsupported musl Linux systems before an agent launch can crash the manager. The install check requires glibc on Linux and leaves macOS and Windows unchanged.
