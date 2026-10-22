---
"@cotal-ai/auth": patch
---

A spawner whose grant covers its own event channel may now hand each child that child's own event channel, `events.<owner>.<child>`, and no other.

The ledger's delegation rule checked a child's event channel against the spawner's post list like any other channel. A spawner that holds only its own event channel, such as a signed-in native conversation, could therefore never spawn on a mesh that requires events: the Manager adds each child's own event channel, and the ledger refused it. The spawner's own event channel is still checked against its parent up to the root, so a parent that may not post events still cannot pass them down, and a sibling's event channel is still refused.
