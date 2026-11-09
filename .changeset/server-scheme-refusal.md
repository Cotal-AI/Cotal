---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal send`, `history`, and `who` now refuse a `--server` value that is not a broker URL, instead of dialing its host and port in plaintext. A missing scheme, `http://`, `https://`, `tcp://`, a path, a query, or a fragment is refused before the command runs. `nats://`, `tls://`, `ws://`, and `wss://` are unchanged, and a websocket URL still keeps its path.
