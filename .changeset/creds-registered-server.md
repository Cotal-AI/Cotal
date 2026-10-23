---
"@cotal-ai/workspace": patch
---

A command given `--creds <file>` and no `--server`, such as `cotal send` or `cotal history`, no longer presents that credential to the default address `nats://127.0.0.1:4222`. It goes to the broker the `--space` is registered at (`main` when no space is named), with that registration's TLS requirement. A space not registered here is refused with `TARGET_NOT_FOUND` before anything is dialed. Before, the registration was ignored and the credential was offered to whatever listened on the default port.
