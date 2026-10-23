---
"@cotal-ai/cli": patch
---

`up` now refuses a `tls://` broker address, from `--server` or a manifest's `broker.servers`, when no
TLS certificate and key are configured. It used to start a plaintext broker and record the `tls://`
address, which every later dial reads as required TLS. The refusal is `USAGE_INVALID` before anything
starts, and it names `--tls-cert` and `--tls-key`, or a `nats://` address.
