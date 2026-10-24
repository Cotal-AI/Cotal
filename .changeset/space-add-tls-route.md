---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`space add` and `meshes add` refusing a public address or a host name without required TLS now say the connection must require TLS and name the `tls://` form of the same address, or `wss://` for `ws://`, as the next step, instead of asking for the address itself. A user-auth space from a bundle whose broker does not answer now gets the same diagnosis as a `--server` one: a host name that does not resolve, a port that takes no connection, or a broker under another scheme.
