---
"@cotal-ai/cli": patch
---

`cotal down` and `cotal describe` now dial with the TLS requirement the mesh record holds, instead
of passing `tls: false` at every one of their three dials. On a mesh recorded `tls://`, `wss://` or
added with `--tls`, those connections previously tolerated a plaintext broker; they now require the
handshake, which is what the recorded requirement means everywhere else. This is fail-closed on
`down`, a destructive command: a mesh recorded TLS-required whose broker answers plaintext now
fails there. Target preflight already refuses that mesh one step earlier, so no reachable mesh
changes behaviour.
