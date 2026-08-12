---
"@cotal-ai/core": patch
"cotal-ai": patch
---

Read channel history through the delivery daemon instead of a consumer you create yourself.

Reading scrollback used to require the reader to hold consumer-create on the chat stream. That is a
lot of authority for a read-only surface: it is the one grant shape the protocol's mediated-reads
rule says an untrusted holder should not have, since it addresses the stream directly rather than the
messages you are allowed to see. A read-only dashboard or UI paid for a page of history with it.

`readHistory` moves that read behind the delivery daemon, which already holds the trusted reader and
the membership authority. The caller asks for a channel and gets its recent messages back; the daemon
is the one holding the consumer. The caller cannot claim to be someone else — the daemon takes the
principal from the authenticated request itself and ignores any identity in the payload.

The reason this is more than a reshuffle is when authorization is checked. A consumer decides what
you may read at the moment it is created and then keeps serving you, so revoking someone's access
mid-scroll does not stop the pages already flowing. The daemon re-reads the caller's permissions from
the durable registry on every single call, so a revocation stops the very next read.

A page is the newest N messages, with a flag saying whether older history remains behind it, because
"there is more above this" and "this is the beginning of the conversation" are different answers and
a UI that cannot tell them apart will render the first as the second. Asking for a channel you may
not read fails loudly, and so does a read that could not complete; neither comes back as an empty
page, which would look exactly like a channel nobody has posted to.

This is additive. Nothing is removed and no existing caller changes: reading history the previous way
still works, and moving to the mediated path is a separate migration. Chat channels only.

Authorization is the live registry row intersected with the mint-time ceiling. Revoking access
(narrowing the live row) stops the very next page. Widening the registry without re-minting the
caller's credential does not grant history the broker would still deny — the ceiling only rises
when the credential does.

