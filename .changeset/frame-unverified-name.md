---
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
---

Message frames, preview rows and wake hints now mark a sender's name and role as `(unverified name)`, or `(unverified role)` when the name is blank and the frame shows the sender's id. The sender writes both itself; the `sender_id` beside them is the identity the broker checked. A long label is cut before the marker, so every bounded form keeps it. The Claude channel tag's `from` attribute carries the same marked label. A peer label now turns a double quote into a space, as it does a bracket.
