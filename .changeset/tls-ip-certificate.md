---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

A TLS stack whose certificate names its IP address now starts. Every TLS dial to an IP address checked the certificate against `localhost`, so `cotal up --server tls://127.0.0.1:<port>` with a valid certificate for that address waited out its readiness and failed `OPERATION_UNKNOWN` with no cause, even with the CA trusted. When this client refuses the certificate, `up` now stops at the first handshake, fails `OPERATION_FAILED` (exit 5) with the native error, and names `NODE_EXTRA_CA_CERTS` as the way to trust a self-signed certificate or a local CA. A `nats://` address with such a certificate names the `tls://` address to use instead.
