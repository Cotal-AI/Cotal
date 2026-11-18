---
"cotal-ai": patch
---

Refuse CLI startup on unsupported musl Linux systems before an agent launch can crash the manager. The startup check recognizes dynamic and static glibc Node builds even when a package manager skips install scripts, removes a delegated child's managed handoff before refusing, and leaves macOS and Windows unchanged.
