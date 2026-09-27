---
"@cotal-ai/connector-codex": patch
---

Compare receive keys in the codex steer filter, so an empty-id message already steered into a turn is not steered again.

`surfaced` holds receive keys (a minted one for an id-less delivery), but the steer filter tested the raw `item.id`. For a message whose wire id is the empty string that test never matched, so every pass of the steer loop re-admitted an already-steered empty-id item and injected it again into the live turn for as long as the turn stayed open. The filter now tests `item.recvKey` against the set, with a one-line comment stating that `surfaced` holds receive keys.
