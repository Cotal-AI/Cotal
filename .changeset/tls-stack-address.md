---
"@cotal-ai/cli": patch
---

`cotal up --tls-cert` now records the stack's address as `tls://` and names it on the receipt's `TLS: serving` line, so every client checks the certificate against that address. An address `up` chooses, the default or the one a stopped folder last ran at, becomes `tls://`, and `--server nats://…` with `--tls-cert` refuses `USAGE_INVALID` before anything starts, naming the `tls://` form. Such a start used to run the broker and then fail its own certificate check against `localhost`.
