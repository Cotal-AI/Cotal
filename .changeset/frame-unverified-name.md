---
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Message frames, preview rows, wake hints and the note naming withheld senders now mark a sender's name and role as `(unverified name)`, or `(unverified role)` when the name is blank and the frame shows the sender's id. The sender writes both itself; the `sender_id` beside them is the identity the broker checked. A long sender label is cut before the marker, and a preview row caps its channel or role label, so the marker stays whole in the 40-character notes and in each preview row. The Claude channel tag's `from` attribute carries the same marked label. A peer label now turns a double quote into a space, as it does a bracket, and the console's recipient completion uses the peer's id when the shown label differs from its name.
