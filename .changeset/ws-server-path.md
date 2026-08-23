---
"@cotal-ai/cli": patch
---

Accept a path on ws:// and wss:// --server URLs in `meshes add`. The public face legitimately advertises a path-carrying websocket broker address (`wss://host/mesh-ws` behind a reverse proxy) and the dial layer already honours it, but checkServer refused it as non-bare — so the face's own generated bundle could not be registered. nats:// and tls:// URLs stay bare.
