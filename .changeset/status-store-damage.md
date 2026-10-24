---
"@cotal-ai/cli": patch
---

`cotal status` now shows a `Store` row reading `damage logged` when the space's running local broker logged damage in a stored file since it started: a message block whose records do not parse, a stream whose recovery rolled back past what a consumer had delivered, or a stream metafile that fails its checksum. The row quotes the broker's warning, and for a controller stack the Next is `cotal service logs stack-broker`. It used to report the store as fine while `history` returned fewer messages, and only the broker's log said why.
