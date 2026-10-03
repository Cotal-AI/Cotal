---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

Keep the liveness responders bound across reconnects

A liveness responder was bound once, on the connection that was current when it started. A full
endpoint reconnect closed that connection and the responder with it. The remote manager runs one
after every credential renewal. A peer probing the plane then got the broker's no-responders answer
and was told `unbound` while the manager or the delivery daemon was connected and serving. The
endpoint now keeps each responder as intent and binds it again on every connection it opens, under
a new responder token.

The manager's responder also answered `bound` after its service connection closed, for as long as
it waited to re-dial, because it only checked that it still held a serve handle. It now answers
`unbound` until the re-dial has bound the service again.
