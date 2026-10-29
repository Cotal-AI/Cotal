---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

The guided `cotal meshes add` on a terminal now takes `--tls` as the flag form does. A host name
whose broker requires TLS passes the address rule, the probe requires the handshake, and the record
carries the TLS requirement. The guided form used to read TLS intent only from a `tls://` scheme, so
`--server nats://<host> --tls` was refused as a host name, and a loopback registration with `--tls`
was recorded without the requirement. The `--force` help now says that the address rules still apply.
