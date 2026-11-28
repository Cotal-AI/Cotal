---
"@cotal-ai/seat": minor
"@cotal-ai/manager": patch
---

Add Linux kernel process handles for owned local process observation.

Capture connected Unix peers without a numeric-PID lookup, recover only matching recorded identities, and observe exit with cancellable kernel readiness events. Closing a handle releases observation without declaring that work ended. The built-in PTY runtime still refuses automatic restart without work-closure support.

Add an unregistered namespace adapter and packaged Node bootstrap for integration qualification. It does not make a new runtime selectable or enable automatic restart support.

Expose retained kernel-object metadata and independently closeable copies. Import borrowed live or exited pidfds only against trusted same-boot receipts and matching pidfs identity; non-pidfds and thread-only handles refuse. Import does not install a descriptor store, authenticate service custody or complete cold Manager recovery.

Request systemd descriptor storage and removal through installed libsystemd without exposing an owned descriptor. Bounded notification acknowledgments run off the JS thread and do not prove store acceptance; hosts must independently verify service custody and exact object metadata.

Bind the unregistered namespace adapter to explicitly pinned native user-service custody. Preserve lossless kernel identity, confirm retention before execution, refuse late admission, and recover cold Manager work through retained descriptors. This does not configure or enable a new runtime in the CLI.
