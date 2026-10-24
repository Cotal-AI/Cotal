---
"@cotal-ai/cli": patch
---

`cotal up -f` under a TLS certificate this client does not trust now fails as `cotal up` does:
`OPERATION_FAILED`, exit 5, naming the native error and the step that sets `NODE_EXTRA_CA_CERTS`.
It printed the failure alone and exited 1, with no code and no step.
