---
"@cotal-ai/core": patch
---

ws/wss dials no longer pass a `tls` block (the URL scheme already decides TLS on the
websocket transport, which refuses the option outright), and the standalone channel
helpers now pick their transport by scheme instead of always dialing TCP — so
`channels list`, `send`, and every endpoint connect work against a `wss://` broker.
