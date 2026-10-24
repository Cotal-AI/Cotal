---
"@cotal-ai/cli": patch
---

`cotal up` on a freshly prepared root no longer starts the legacy launcher when it is given an option the controller stack has no route for, such as `--tls-cert`, `--tls-key` or `--rotate-sys`. It refuses `UNSUPPORTED` before anything starts, as a root whose stack the controller already owns does. The refusal now names each option, names the `cotal up -f <cotal.yaml>` route when it takes them, and says that a first start has no `$SYS` creds to rotate.
