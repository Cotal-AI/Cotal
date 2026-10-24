---
"@cotal-ai/cli": patch
---

A space prepared with `cotal space create` cannot serve TLS through a plain `cotal up`, and its refusals sent each attempt to another one that refused too: `--server nats://` with `--tls-cert` asked for `tls://`, `tls://` with the pair had no route, and `tls://` alone asked for `--tls-cert`. On such a root, and on one whose stack the service controller owns, any of those now refuses `UNSUPPORTED`, exit 2, once and before anything starts, and on a prepared root it names `cotal up -f <cotal.yaml> --tls-cert <cert.pem> --tls-key <key.pem>` with a `tls://` address in the manifest, which serves TLS there. The `--tls-cert` docs say so.
